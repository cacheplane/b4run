/** Trusted preparation program. Source is transported only as JSON stdin, never executed. */
export const prepareWorkspaceScript = `
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = '/workspace';
if (fs.readdirSync(root).length) throw Error('Preparation volume must be empty');
for (const link of input.links) {
  const target = fs.realpathSync(link.target);
  if (['/workspace','/tmp','/run','/dev','/proc','/sys'].some(p=>target===p || target.startsWith(p+'/')) || !fs.statSync(target).isDirectory()) throw Error('Unsupported environment link target');
}
for (const file of input.files) {
  const dest = path.join(root,file.path);
  fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o755});
  fs.writeFileSync(dest,Buffer.from(file.base64,'base64'),{flag:'wx',mode:file.executable?0o755:0o644});
  fs.chmodSync(dest,file.executable?0o755:0o644);
}
for(const link of input.links) {
  const dest=path.join(root,link.path); fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o755}); fs.symlinkSync(link.target,dest);
}
let baselineCommit;
if(input.baseline==='git') {
  const env={PATH:process.env.PATH,HOME:'/tmp',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'Workspace Baseline',GIT_AUTHOR_EMAIL:'workspace@localhost',GIT_COMMITTER_NAME:'Workspace Baseline',GIT_COMMITTER_EMAIL:'workspace@localhost',GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'};
  const git=(args)=>cp.execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,env,encoding:'utf8'}).trim();
  git(['init','--template=','--initial-branch=main']);
  for(const item of [...input.files,...input.links]) git(['add','--force','--',item.path]);
  git(['-c','commit.gpgsign=false','commit','--allow-empty','-m','Initial workspace']);
  baselineCommit=git(['rev-parse','HEAD']);
  if(git(['status','--porcelain'])) throw Error('Dirty initial baseline');
}
for(const file of input.files) {
 const dest=path.join(root,file.path),stat=fs.lstatSync(dest);
 if(!stat.isFile() || fs.readFileSync(dest).toString('base64')!==file.base64 || (stat.mode&0o777)!==(file.executable?0o755:0o644)) throw Error('Source verification failed');
}
const own=(p)=>{const stat=fs.lstatSync(p);fs.lchownSync(p,1000,1000);if(stat.isDirectory())for(const name of fs.readdirSync(p))own(path.join(p,name));};own(root);
process.stdout.write(JSON.stringify(baselineCommit?{baselineCommit}:{}));
`
