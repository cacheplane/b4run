import { createDocker, type Docker, type SpawnResult } from "../../../src/docker/docker-cli.ts"
import type { SourceManifest } from "./manifest.ts"
import type { Attempt } from "./types.ts"

export interface ResourceState {
  volume: boolean
  preparer?: { id: string; running: boolean }
  session?: { id: string; running: boolean }
}
export type DockerFault = (phase: "created" | "copying" | "validated") => Promise<void>

const materialize = String.raw`
const fs = require('node:fs'); const path = require('node:path');
const {execFileSync} = require('node:child_process');
const input = JSON.parse(fs.readFileSync(0,'utf8'));
for (const file of input.files) {
  const target = path.join('/workspace',file.path);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,file.content,{mode:file.executable?0o755:0o644});
  fs.chmodSync(target,file.executable?0o755:0o644);
}
if (input.partial) process.exit(0);
fs.symlinkSync(input.dependencyTarget,'/workspace/node_modules');
fs.mkdirSync('/tmp/empty-template');
const env = {PATH:process.env.PATH, HOME:'/tmp', GIT_CONFIG_NOSYSTEM:'1',
 GIT_CONFIG_GLOBAL:'/dev/null', GIT_AUTHOR_NAME:'B4 fixture',
 GIT_AUTHOR_EMAIL:'fixture@example.invalid', GIT_COMMITTER_NAME:'B4 fixture',
 GIT_COMMITTER_EMAIL:'fixture@example.invalid', GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',
 GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'};
const git = (...args) => execFileSync('git',args,{cwd:'/workspace',env,encoding:'utf8'});
git('init','-q','--template=/tmp/empty-template','--initial-branch=main');
git('add','--',...input.files.map(f=>f.path));
git('-c','commit.gpgsign=false','commit','-qm','baseline');
const expected=input.files.map(f=>f.path).sort(); const found=[];
function walk(dir,relative='') {
 for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
  const p=relative?relative+'/'+e.name:e.name;
  if(p==='.git') {if(!e.isDirectory()) throw Error('Invalid Git metadata'); continue;}
  if(p==='node_modules') {
   if(!e.isSymbolicLink()||fs.readlinkSync(path.join(dir,e.name))!==input.dependencyTarget)
    throw Error('Invalid dependency link'); continue;
  }
  if(e.isDirectory()) walk(path.join(dir,e.name),p);
  else if(e.isFile()) found.push(p); else throw Error('Unexpected entry '+p);
 }
}
walk('/workspace');
if(JSON.stringify(found.sort())!==JSON.stringify(expected)) throw Error('Inventory mismatch');
for(const f of input.files) {
 const p=path.join('/workspace',f.path);
 if(fs.readFileSync(p,'utf8')!==f.content || (fs.statSync(p).mode&0o777)!==(f.executable?0o755:0o644))
  throw Error('Source validation failed '+f.path);
}
if(JSON.stringify(git('ls-files','-z').split('\0').filter(Boolean).sort())!==JSON.stringify(expected))
 throw Error('Tracked inventory mismatch');
const status=git('status','--porcelain').trim(); if(status) throw Error('Dirty initial baseline: '+status);
function own(p) { const s=fs.lstatSync(p); fs.lchownSync(p,1000,1000);
 if(s.isDirectory()) for(const n of fs.readdirSync(p)) own(path.join(p,n)); }
own('/workspace');
process.stdout.write(git('-c','safe.directory=/workspace','rev-parse','HEAD').trim());
`

/** Test-only physical resources. No provider or public API changes. */
export class RecoveryDocker {
  readonly docker: Docker
  readonly fault: DockerFault
  constructor(docker: Docker = createDocker(), fault: DockerFault = async () => {}) {
    this.docker = docker
    this.fault = fault
  }

  async checked(args: readonly string[]): Promise<string> {
    return this.result(await this.docker.run(args, { signal: AbortSignal.timeout(60_000) }))
  }

  result(result: SpawnResult): string {
    if (result.exitCode !== 0) throw new Error(`Unavailable: ${result.stderr || result.stdout}`)
    return result.stdout.trim()
  }

  labels(a: Attempt): Record<string, string> {
    return {
      "b4.recovery.installation": a.installationId,
      "b4.recovery.generation": a.generationId,
      "b4.recovery.logical": a.logicalId,
    }
  }

  assertOwned(actual: Record<string, string> | null | undefined, a: Attempt): void {
    for (const [key, value] of Object.entries(this.labels(a)))
      if (actual?.[key] !== value) throw new Error("Conflict: resource ownership mismatch")
  }

  async inspect(a: Attempt): Promise<ResourceState> {
    const volumes = (await this.checked(["volume", "ls", "--format", "{{.Name}}"])).split("\n")
    const volume = volumes.includes(a.volumeName)
    if (volume) {
      const [v] = JSON.parse(await this.checked(["volume", "inspect", a.volumeName]))
      if (v.Name !== a.volumeName) throw new Error("Conflict: volume identity mismatch")
      this.assertOwned(v.Labels, a)
    }
    const containers = (await this.checked(["ps", "-a", "--format", "{{.Names}}"])).split("\n")
    const state: ResourceState = { volume }
    for (const role of ["preparer", "session"] as const) {
      const name = role === "preparer" ? a.preparerName : a.sessionName
      if (!containers.includes(name)) continue
      const [c] = JSON.parse(await this.checked(["inspect", name]))
      this.assertOwned(c.Config?.Labels, a)
      const pinned = role === "preparer" ? a.preparerId : a.sessionId
      if (c.Name !== `/${name}` || (pinned && pinned !== c.Id) || c.Image !== a.imageId)
        throw new Error("Conflict: container identity mismatch")
      if (
        !c.Mounts?.some(
          (m: { Name?: string; Destination?: string }) =>
            m.Name === a.volumeName && m.Destination === "/workspace",
        )
      )
        throw new Error("Conflict: workspace mount mismatch")
      state[role] = { id: c.Id, running: c.State.Running }
    }
    return state
  }

  async resolveImage(image: string): Promise<string> {
    const id = await this.checked(["image", "inspect", "--format", "{{.Id}}", image])
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Invalid resolved image identity")
    return id
  }

  async hasResources(installationId: string, logicalId: string): Promise<boolean> {
    const filters = [
      "--filter",
      `label=b4.recovery.installation=${installationId}`,
      "--filter",
      `label=b4.recovery.logical=${logicalId}`,
    ]
    const volumes = await this.checked(["volume", "ls", ...filters, "--format", "{{.Name}}"])
    const containers = await this.checked(["ps", "-a", ...filters, "--format", "{{.ID}}"])
    return !!(volumes || containers)
  }

  async createContainer(a: Attempt, role: "preparer" | "session"): Promise<string> {
    return this.checked([
      "create",
      "--name",
      role === "preparer" ? a.preparerName : a.sessionName,
      ...Object.entries(this.labels(a)).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev",
      "--memory",
      "1g",
      "--pids-limit",
      "128",
      "--security-opt",
      "no-new-privileges",
      ...(role === "session" ? ["--user", "1000:1000", "--cap-drop", "ALL"] : ["--user", "0:0"]),
      "--mount",
      `type=volume,source=${a.volumeName},target=/workspace,volume-nocopy`,
      "--workdir",
      "/workspace",
      a.imageId,
      "sleep",
      "infinity",
    ])
  }

  async prepare(a: Attempt, source: SourceManifest, imageId: string): Promise<void> {
    if (imageId !== a.imageId) throw new Error("Conflicting environment")
    const before = await this.inspect(a)
    if (before.volume || before.preparer || before.session)
      throw new Error("Attempt already exists")
    await this.checked([
      "volume",
      "create",
      ...Object.entries(this.labels(a)).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      a.volumeName,
    ])
    const id = await this.createContainer(a, "preparer")
    a.preparerId = id
    const created = await this.inspect(a)
    if (!created.volume || created.preparer?.id !== id || created.preparer.running)
      throw new Error("Created preparer identity or stopped state unconfirmed")
    await this.checked(["start", id])
    await this.fault("created")
    this.result(
      await this.docker.exec(id, ["node", "-e", materialize], {
        stdin: JSON.stringify({ ...source, files: source.files.slice(0, 1), partial: true }),
        signal: AbortSignal.timeout(60_000),
      }),
    )
    await this.fault("copying")
    this.result(
      await this.docker.exec(id, ["node", "-e", materialize], {
        stdin: JSON.stringify(source),
        signal: AbortSignal.timeout(60_000),
      }),
    )
    await this.fault("validated")
  }

  async stop(a: Attempt): Promise<void> {
    const state = await this.inspect(a)
    for (const role of ["preparer", "session"] as const) {
      const c = state[role]
      if (c?.running) await this.checked(["stop", "--time", "1", c.id])
    }
    const stopped = await this.inspect(a)
    if (stopped.preparer?.running || stopped.session?.running)
      throw new Error("Termination uncertain")
  }

  async attach(a: Attempt, imageId: string): Promise<string> {
    if (imageId !== a.imageId) throw new Error("Conflicting environment")
    const state = await this.inspect(a)
    if (!state.volume) throw new Error("Lost workspace")
    if (state.preparer?.running) throw new Error("Preparer still running")
    const id = state.session?.id ?? (await this.createContainer(a, "session"))
    a.sessionId = id
    const created = await this.inspect(a)
    if (!created.volume || created.session?.id !== id)
      throw new Error("Created session identity unconfirmed")
    if (!state.session?.running) await this.checked(["start", id])
    return id
  }

  async release(a: Attempt): Promise<void> {
    const state = await this.inspect(a)
    if (state.session) await this.checked(["rm", "-f", state.session.id])
    if ((await this.inspect(a)).session) throw new Error("Session removal uncertain")
    delete a.sessionId
  }

  async destroy(a: Attempt): Promise<void> {
    await this.stop(a)
    const state = await this.inspect(a)
    for (const role of ["preparer", "session"] as const)
      if (state[role]) await this.checked(["rm", state[role].id])
    if (state.volume) await this.checked(["volume", "rm", a.volumeName])
    const after = await this.inspect(a)
    if (after.volume || after.preparer || after.session) throw new Error("Cleanup incomplete")
  }
}
