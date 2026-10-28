import { createHash } from "node:crypto"
import * as records from "../../historical-publication-record.mjs"

// Public historical release bytes, exclusively test evidence; no production admission record.
export const TEST_MANIFEST = {
  artifact: {
    name: "release-v0.15.5-877ce4899406",
    prepareRunAttempt: 1,
    prepareRunId: 40370125207,
  },
  ci: {
    runAttempt: 1,
    runId: 40345947946,
    workflow: "CI",
  },
  commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
  packageOrder: [
    "@b4run/config-biome",
    "@b4run/config-typescript",
    "@b4run/devkit",
    "@b4run/sdk",
    "@b4run/ag-ui",
    "@b4run/langgraph",
    "@b4run/permissions",
    "@b4run/postgres-storage",
    "@b4run/workspace",
    "@b4run/sandbox",
    "@b4run/sqlite-storage",
    "@b4run/core",
    "@b4run/langchain",
    "@b4run/memory",
    "@b4run/cli",
    "@b4run/inspector",
    "@b4run/memory-pgvector",
    "@b4run/testing",
    "@b4run/evals",
    "@b4run/vite-plugin",
    "create-b4-app",
  ],
  packages: [
    {
      access: "public",
      filename: "b4run-config-biome-0.15.5.tgz",
      name: "@b4run/config-biome",
      npmIntegrity:
        "sha512-3q8O/u6tR522UkyFiGPIvZGWx7fJrGFCuv/aNILZ8aTddUbthUT2hQPABgdWBS2OfevilvrfXc6mCc0G6Doy3g==",
      sha256: "3feb1c8f0d9ad1a515448cfaf541f0e5fc04e34e0ad60f4b9bb3c11e34ef8148",
      sha512:
        "deaf0efeeead479db6524c858863c8bd9196c7b7c9ac6142baffda3482d9f1a4dd7546ed8544f68503c0060756052d8e7debe296fadf5dcea609cd06e83a32de",
      size: 2293,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-config-typescript-0.15.5.tgz",
      name: "@b4run/config-typescript",
      npmIntegrity:
        "sha512-9YXOiCJf9Aa0PIGuQDpHnvK89eiCW9cx32m3MZpov5n+boLCiKRRvNJGFydCemLA9g1b+6q1uAgbGAlm9+lbEQ==",
      sha256: "69b0cd78e1464500fe3c92c82477b4e8205da827acbe41eb46987949109bec90",
      sha512:
        "f585ce88225ff406b43c81ae403a479ef2bcf5e8825bd731df69b7319a68bf99fe6e82c288a451bcd2461727427a62c0f60d5bfbaab5b8081b180966f7e95b11",
      size: 2511,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-devkit-0.15.5.tgz",
      name: "@b4run/devkit",
      npmIntegrity:
        "sha512-KbVAZlfRFW3JVfXoBe1LOGI9Y0erk/5K/Aqr2sKHX+lcgMNi6aebGTHiPp3AAHio8RixSbGmpmG7ZOcE/uxJiQ==",
      sha256: "f044c8146cbe4297015a7054631306b53ba0e7a80235bc06c8d1dd26fa019cc7",
      sha512:
        "29b5406657d1156dc955f5e805ed4b38623d6347ab93fe4afc0aabdac2875fe95c80c362e9a79b1931e23e9dc00078a8f118b149b1a6a661bb64e704feec4989",
      size: 795582,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-sdk-0.15.5.tgz",
      name: "@b4run/sdk",
      npmIntegrity:
        "sha512-OvZRspiGZ4kFBz5uJCxtNu0QFaO+LLOpNHHDSwzKsDccKlh8RQOydqUoFR3Q5LlcMSkcjQlhGmDIPZYnLQvHCg==",
      sha256: "b24d64a630c8e3ae12c422240d4d5f56a44f2322774262a91ca4e630f5a1360d",
      sha512:
        "3af651b29886678905073e6e242c6d36ed1015a3be2cb3a93471c34b0ccab0371c2a587c4503b276a528151dd0e4b95c31291c8d09611a60c83d96272d0bc70a",
      size: 109704,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-ag-ui-0.15.5.tgz",
      name: "@b4run/ag-ui",
      npmIntegrity:
        "sha512-TNYDFxY7fYLzTHYcYyuwAlWsPiemBYkVYA7sLEw9QF0WnMxqgVNHBuKr0EId61k8fcrCA/ndSyL7U5QjJzaJLQ==",
      sha256: "665327fe933fb0f535baa7b2bf8f0c99dc66cd05c7be9d57f809fc3f9decfea5",
      sha512:
        "4cd60317163b7d82f34c761c632bb00255ac3e27a6058915600eec2c4c3d405d169ccc6a81534706e2abd0421deb593c7dcac203f9dd4b22fb5394232736892d",
      size: 212754,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-langgraph-0.15.5.tgz",
      name: "@b4run/langgraph",
      npmIntegrity:
        "sha512-GBEnKHn6TVN8wZWVwaOdehgNIfPNlx8rge41iYY6U5mqPy6R9T6NZ7yAamx1rImYzt8+FA3+UljSALSuuolr6g==",
      sha256: "6c9d586cee9243c3371edac5d2a9fdd49bf0d8372d1552507c7aac3050cfa8e3",
      sha512:
        "1811272879fa4d537cc19595c1a39d7a180d21f3cd971f2b81ee3589863a5399aa3f2e91f53e8d67bc806a6c75ac8998cedf3e140dfe5258d200b4aeba896bea",
      size: 35614,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-permissions-0.15.5.tgz",
      name: "@b4run/permissions",
      npmIntegrity:
        "sha512-5932amTTwjBMAWRwAaMF3y40vh1pFPrHAuUa85t0l6A+OufDoLdBcqc8BxDLXLOQtk+4JYXQ5i0Z026sCq7f7w==",
      sha256: "9bff9d09e796a5747d125f0bc740c2113ac1e4d804c727db35f1131a082552a1",
      sha512:
        "e7ddf66a64d3c2304c01647001a305df2e34be1d6914fac702e51af39b7497a03e3ae7c3a0b74172a73c0710cb5cb390b64fb82585d0e62d19d36eac0aaedfef",
      size: 17868,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-postgres-storage-0.15.5.tgz",
      name: "@b4run/postgres-storage",
      npmIntegrity:
        "sha512-dQbNyCCnhwO4Tjo11acYveol0Ue1Bl8ociuUUcVaC6CluKrUAJ19s3MX2Rro3F9XSO/DUgjHm1oNM7bOXIOPLA==",
      sha256: "d23f5f45bf41c00267b08f0e881adb890e679ce226edec6d10e2ea8c469b3099",
      sha512:
        "7506cdc820a78703b84e3a35d5a718bdea25d147b5065f28722b9451c55a0ba0a5b8aad4009d7db37317d91ae8dc5f5748efc35208c79b5a0d33b6ce5c838f2c",
      size: 63471,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-workspace-0.15.5.tgz",
      name: "@b4run/workspace",
      npmIntegrity:
        "sha512-cFOX4z910efvItQ3OxquKOknHMCsO+90ACTIBF5RYElmFcMDLx79c9rGgHDDsbxj+hW0u3kIQK2jwoC/VY+XZQ==",
      sha256: "a5b24e9d97007c4739afe20d9b41d8eb726c58a91f292451d6bda3ae233f4f9b",
      sha512:
        "705397e33f75d1e7ef22d4373b1aae28e9271cc0ac3bef740024c8045e5160496615c3032f1efd73dac68070c3b1bc63fa15b4bb790840ada3c280bf558f9765",
      size: 55188,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-sandbox-0.15.5.tgz",
      name: "@b4run/sandbox",
      npmIntegrity:
        "sha512-pteJjfh2U/9HAaoUz92aHaiC646uYOrJa6WZqUj6I8cb0t2QT3G5F+9wwyO/yHJtlcoOz4YxSzsFKXbKbfK+HQ==",
      sha256: "33f6eb4b7108457ef7ad2fbd3e902e80762e32cd3a495916a4bad345399d8d18",
      sha512:
        "a6d7898df87653ff4701aa14cfdd9a1da882eb8eae60eac96ba599a948fa23c71bd2dd904f71b917ef70c323bfc8726d95ca0ecf86314b3b052976ca6df2be1d",
      size: 93329,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-sqlite-storage-0.15.5.tgz",
      name: "@b4run/sqlite-storage",
      npmIntegrity:
        "sha512-xF8+dE4AMGLtU1YfO+x2kig8ENVIBYxPHbWITRsRN+V7HoeVlNm2IbD+K+K7fQ03gJDV4/incCz09TjlnHvBLw==",
      sha256: "b5404a9070ce620093741bfdfec4442876ca4f36547d43a1c148ada5fe8e22e4",
      sha512:
        "c45f3e744e003062ed53561f3bec7692283c10d548058c4f1db5884d1b1137e57b1e879594d9b621b0fe2be2bb7d0d378090d5e3f8a7702cf4f538e59c7bc12f",
      size: 56504,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-core-0.15.5.tgz",
      name: "@b4run/core",
      npmIntegrity:
        "sha512-4D9Y9+pbFKwopzFsI0qD91PB66pBHAxNd14Ax6/L1LDO0TnfRWXBNN9t/CoJ1N8QDG84/3ZNsicG8qeAFpASeQ==",
      sha256: "8856258e088898fef62ed02fff715d67c14420a5bca430ab7e916694af33b8ea",
      sha512:
        "e03f58f7ea5b14ac28a7316c234a83f753c1ebaa411c0c4d775e00c7afcbd4b0ced139df4565c134df6dfc2a09d4df100c6f38ff764db22706f2a78016901279",
      size: 129983,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-langchain-0.15.5.tgz",
      name: "@b4run/langchain",
      npmIntegrity:
        "sha512-AyF1dMxm0B744FiWbJ8HsPowOjkDfPjD0/7Nf1ETrAO1W8rTsZkTC/SutTZJrwHWYPuPLAUMKVZMdwRAsDotSw==",
      sha256: "c22e6ac8ab6a712fbbd8e0cfe9b0db7c5a991f045ba49c624e3007e597cae982",
      sha512:
        "03217574cc66d01ef8e058966c9f07b0fa303a39037cf8c3d3fecd7f5113ac03b55bcad3b199130bf4aeb53649af01d660fb8f2c050c29564c770440b03a2d4b",
      size: 114966,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-memory-0.15.5.tgz",
      name: "@b4run/memory",
      npmIntegrity:
        "sha512-Fwfj/y/qjj6tT+0w5Fp4PHG7VM42oHgjq7WysITKvNdSsEQao/oPanfrwETcvgT8NH38IzsYa6s275EzSIw3Qw==",
      sha256: "ecc699f1b89983e94c43d72983367498fcf52c5e695b34b6983e9c9c38321a82",
      sha512:
        "1707e3ff2fea8e3ead4fed30e45a783c71bb54ce36a07823abb5b2b084cabcd752b0441aa3fa0f6a77ebc044dcbe04fc347dfc233b186bab36ef9133488c3743",
      size: 59915,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-cli-0.15.5.tgz",
      name: "@b4run/cli",
      npmIntegrity:
        "sha512-nQMQLNYFEyXnoQHvl+8beqGPlDuxfWqPZ0uKtnjDDPGa1GjhKhGTyIZvHjxwrZkc3di/gwDlQKcDsbWBGihpCg==",
      sha256: "fe382e5389de7be297ef75aec79bb9544500360de027346522d2da5556e00f3f",
      sha512:
        "9d03102cd6051325e7a101ef97ef1b7aa18f943bb17d6a8f674b8ab678c30cf19ad468e12a1193c8866f1e3c70ad991cddd8bf8300e540a703b1b5811a28690a",
      size: 905987,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-inspector-0.15.5.tgz",
      name: "@b4run/inspector",
      npmIntegrity:
        "sha512-dcXMzhVDlCrhJG6Oc8jNkhuT7UzFervnCBXXzsLZwruv7qMI5Wc2Is9KT1QWrck9hNdoCXMMUuqff/ay2+RPGQ==",
      sha256: "4513206ccabda1bdc036b48a1b04e3bc0e1cb3f17345326097927d8e4fae0c17",
      sha512:
        "75c5ccce1543942ae1246e8e73c8cd921b93ed4cc57abbe70815d7cec2d9c2bbafeea308e5673622cf4a4f5416adc93d84d76809730c52ea9f7ff6b2dbe44f19",
      size: 12316837,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-memory-pgvector-0.15.5.tgz",
      name: "@b4run/memory-pgvector",
      npmIntegrity:
        "sha512-ugxhAYpIR2ipS+QPwPEV5zSfx/vrQIUQciH5of2tagMvGKKFiUeTCz+QstpP2QsVEHzmoW39VU7fV4VDVw46bw==",
      sha256: "0615ebf95b77df8936ca3f8190ec2ebf5a7d2a908806199b739fefa22c2d34ef",
      sha512:
        "ba0c61018a484768a94be40fc0f115e7349fc7fbeb4085107221f9a1fdad6a032f18a2858947930b3f90b2da4fd90b15107ce6a16dfd554edf578543570e3a6f",
      size: 28308,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-testing-0.15.5.tgz",
      name: "@b4run/testing",
      npmIntegrity:
        "sha512-VdCa6a2uDhr2XDHJIbIspyIzB2Fx6FC/uIPYAzy9I7z5hy1fknwH3YIqmwLmjPSyFGRYPnWCX4sWKUVB6AZyPQ==",
      sha256: "668f989d29ccdb8264c28b276e36fe0a5b54108319ddcdbcf425b602b03bd18b",
      sha512:
        "55d09ae9adae0e1af65c31c921b22ca72233076171e850bfb883d8033cbd23bcf9872d5f927c07dd822a9b02e68cf4b21464583e75825f8b16294541e806723d",
      size: 95537,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-evals-0.15.5.tgz",
      name: "@b4run/evals",
      npmIntegrity:
        "sha512-dGlQ3QDgAdmm6GwAkxoh0/L6MwwyIX8f3vyXhClt34mj7f0qaYNtqThnNDKALcwT2qjrsr2hyVOTRZTC8xVHlw==",
      sha256: "a9f328b155db858661ef122e856801211423c257cdf56e51b9ebe49ce615a1b7",
      sha512:
        "746950dd00e001d9a6e86c00931a21d3f2fa330c32217f1fdefc9784296ddf89a3edfd2a69836da938673432802dcc13daa8ebb2bda1c953934594c2f3154797",
      size: 41810,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "b4run-vite-plugin-0.15.5.tgz",
      name: "@b4run/vite-plugin",
      npmIntegrity:
        "sha512-51RpuEZD7YBJJWj1kP5jUNFvSqFuTmEqw8N/DUfBAduR/s9s2UCtynLv5lK7/eoHQVpZSqzD5mrJvxSNMV+tGw==",
      sha256: "ec82c9661f459a1f8153038ac614bb28c404c2bde78e1285e1c84179fe860512",
      sha512:
        "e75469b84643ed80492568f590fe6350d16f4aa16e4e612ac3c37f0d47c101db91fecf6cd940adca72efe652bbfdea07415a594aacc3e66ac9bf148d315fad1b",
      size: 29313,
      version: "0.15.5",
    },
    {
      access: "public",
      filename: "create-b4-app-0.15.5.tgz",
      name: "create-b4-app",
      npmIntegrity:
        "sha512-1bbAAEW//GHxD+xoFQtRckgNtheryXgGiXkEtn1zJwXnaP+Jza4m5THLojGfln1QQ1glZA8AxXIZc9VtoR/KRQ==",
      sha256: "6599c4260ea825fd66e3ef7934b494aea6fc08140d03ff3078eeed812e2d3f24",
      sha512:
        "d5b6c00045bffc61f10fec68150b5172480db617abc97806897904b67d732705e768ff89cdae26e531cba2319f967d50435825640f00c5721973d56da11fca45",
      size: 15775,
      version: "0.15.5",
    },
  ],
  schemaVersion: 1,
  version: "0.15.5",
}
export const TEST_RECEIPT = {
  commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
  complete: true,
  manifestSha256: "81b7df4408a73b1e236570cace34efbfdd9cea5848dc2f8145cd6d730c29429e",
  packages: [
    {
      integrity:
        "sha512-3q8O/u6tR522UkyFiGPIvZGWx7fJrGFCuv/aNILZ8aTddUbthUT2hQPABgdWBS2OfevilvrfXc6mCc0G6Doy3g==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/config-biome",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 2293,
      status: "present",
      tarballSha256: "3feb1c8f0d9ad1a515448cfaf541f0e5fc04e34e0ad60f4b9bb3c11e34ef8148",
      tarballSha512:
        "deaf0efeeead479db6524c858863c8bd9196c7b7c9ac6142baffda3482d9f1a4dd7546ed8544f68503c0060756052d8e7debe296fadf5dcea609cd06e83a32de",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-9YXOiCJf9Aa0PIGuQDpHnvK89eiCW9cx32m3MZpov5n+boLCiKRRvNJGFydCemLA9g1b+6q1uAgbGAlm9+lbEQ==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/config-typescript",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 2511,
      status: "present",
      tarballSha256: "69b0cd78e1464500fe3c92c82477b4e8205da827acbe41eb46987949109bec90",
      tarballSha512:
        "f585ce88225ff406b43c81ae403a479ef2bcf5e8825bd731df69b7319a68bf99fe6e82c288a451bcd2461727427a62c0f60d5bfbaab5b8081b180966f7e95b11",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-KbVAZlfRFW3JVfXoBe1LOGI9Y0erk/5K/Aqr2sKHX+lcgMNi6aebGTHiPp3AAHio8RixSbGmpmG7ZOcE/uxJiQ==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/devkit",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 795582,
      status: "present",
      tarballSha256: "f044c8146cbe4297015a7054631306b53ba0e7a80235bc06c8d1dd26fa019cc7",
      tarballSha512:
        "29b5406657d1156dc955f5e805ed4b38623d6347ab93fe4afc0aabdac2875fe95c80c362e9a79b1931e23e9dc00078a8f118b149b1a6a661bb64e704feec4989",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-OvZRspiGZ4kFBz5uJCxtNu0QFaO+LLOpNHHDSwzKsDccKlh8RQOydqUoFR3Q5LlcMSkcjQlhGmDIPZYnLQvHCg==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/sdk",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 109704,
      status: "present",
      tarballSha256: "b24d64a630c8e3ae12c422240d4d5f56a44f2322774262a91ca4e630f5a1360d",
      tarballSha512:
        "3af651b29886678905073e6e242c6d36ed1015a3be2cb3a93471c34b0ccab0371c2a587c4503b276a528151dd0e4b95c31291c8d09611a60c83d96272d0bc70a",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-TNYDFxY7fYLzTHYcYyuwAlWsPiemBYkVYA7sLEw9QF0WnMxqgVNHBuKr0EId61k8fcrCA/ndSyL7U5QjJzaJLQ==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/ag-ui",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 212754,
      status: "present",
      tarballSha256: "665327fe933fb0f535baa7b2bf8f0c99dc66cd05c7be9d57f809fc3f9decfea5",
      tarballSha512:
        "4cd60317163b7d82f34c761c632bb00255ac3e27a6058915600eec2c4c3d405d169ccc6a81534706e2abd0421deb593c7dcac203f9dd4b22fb5394232736892d",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-GBEnKHn6TVN8wZWVwaOdehgNIfPNlx8rge41iYY6U5mqPy6R9T6NZ7yAamx1rImYzt8+FA3+UljSALSuuolr6g==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/langgraph",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 35614,
      status: "present",
      tarballSha256: "6c9d586cee9243c3371edac5d2a9fdd49bf0d8372d1552507c7aac3050cfa8e3",
      tarballSha512:
        "1811272879fa4d537cc19595c1a39d7a180d21f3cd971f2b81ee3589863a5399aa3f2e91f53e8d67bc806a6c75ac8998cedf3e140dfe5258d200b4aeba896bea",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-5932amTTwjBMAWRwAaMF3y40vh1pFPrHAuUa85t0l6A+OufDoLdBcqc8BxDLXLOQtk+4JYXQ5i0Z026sCq7f7w==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/permissions",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 17868,
      status: "present",
      tarballSha256: "9bff9d09e796a5747d125f0bc740c2113ac1e4d804c727db35f1131a082552a1",
      tarballSha512:
        "e7ddf66a64d3c2304c01647001a305df2e34be1d6914fac702e51af39b7497a03e3ae7c3a0b74172a73c0710cb5cb390b64fb82585d0e62d19d36eac0aaedfef",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-dQbNyCCnhwO4Tjo11acYveol0Ue1Bl8ociuUUcVaC6CluKrUAJ19s3MX2Rro3F9XSO/DUgjHm1oNM7bOXIOPLA==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/postgres-storage",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 63471,
      status: "present",
      tarballSha256: "d23f5f45bf41c00267b08f0e881adb890e679ce226edec6d10e2ea8c469b3099",
      tarballSha512:
        "7506cdc820a78703b84e3a35d5a718bdea25d147b5065f28722b9451c55a0ba0a5b8aad4009d7db37317d91ae8dc5f5748efc35208c79b5a0d33b6ce5c838f2c",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-cFOX4z910efvItQ3OxquKOknHMCsO+90ACTIBF5RYElmFcMDLx79c9rGgHDDsbxj+hW0u3kIQK2jwoC/VY+XZQ==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/workspace",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 55188,
      status: "present",
      tarballSha256: "a5b24e9d97007c4739afe20d9b41d8eb726c58a91f292451d6bda3ae233f4f9b",
      tarballSha512:
        "705397e33f75d1e7ef22d4373b1aae28e9271cc0ac3bef740024c8045e5160496615c3032f1efd73dac68070c3b1bc63fa15b4bb790840ada3c280bf558f9765",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-pteJjfh2U/9HAaoUz92aHaiC646uYOrJa6WZqUj6I8cb0t2QT3G5F+9wwyO/yHJtlcoOz4YxSzsFKXbKbfK+HQ==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/sandbox",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 93329,
      status: "present",
      tarballSha256: "33f6eb4b7108457ef7ad2fbd3e902e80762e32cd3a495916a4bad345399d8d18",
      tarballSha512:
        "a6d7898df87653ff4701aa14cfdd9a1da882eb8eae60eac96ba599a948fa23c71bd2dd904f71b917ef70c323bfc8726d95ca0ecf86314b3b052976ca6df2be1d",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-xF8+dE4AMGLtU1YfO+x2kig8ENVIBYxPHbWITRsRN+V7HoeVlNm2IbD+K+K7fQ03gJDV4/incCz09TjlnHvBLw==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/sqlite-storage",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 56504,
      status: "present",
      tarballSha256: "b5404a9070ce620093741bfdfec4442876ca4f36547d43a1c148ada5fe8e22e4",
      tarballSha512:
        "c45f3e744e003062ed53561f3bec7692283c10d548058c4f1db5884d1b1137e57b1e879594d9b621b0fe2be2bb7d0d378090d5e3f8a7702cf4f538e59c7bc12f",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-4D9Y9+pbFKwopzFsI0qD91PB66pBHAxNd14Ax6/L1LDO0TnfRWXBNN9t/CoJ1N8QDG84/3ZNsicG8qeAFpASeQ==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/core",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 129983,
      status: "present",
      tarballSha256: "8856258e088898fef62ed02fff715d67c14420a5bca430ab7e916694af33b8ea",
      tarballSha512:
        "e03f58f7ea5b14ac28a7316c234a83f753c1ebaa411c0c4d775e00c7afcbd4b0ced139df4565c134df6dfc2a09d4df100c6f38ff764db22706f2a78016901279",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-AyF1dMxm0B744FiWbJ8HsPowOjkDfPjD0/7Nf1ETrAO1W8rTsZkTC/SutTZJrwHWYPuPLAUMKVZMdwRAsDotSw==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/langchain",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 114966,
      status: "present",
      tarballSha256: "c22e6ac8ab6a712fbbd8e0cfe9b0db7c5a991f045ba49c624e3007e597cae982",
      tarballSha512:
        "03217574cc66d01ef8e058966c9f07b0fa303a39037cf8c3d3fecd7f5113ac03b55bcad3b199130bf4aeb53649af01d660fb8f2c050c29564c770440b03a2d4b",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-Fwfj/y/qjj6tT+0w5Fp4PHG7VM42oHgjq7WysITKvNdSsEQao/oPanfrwETcvgT8NH38IzsYa6s275EzSIw3Qw==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/memory",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 59915,
      status: "present",
      tarballSha256: "ecc699f1b89983e94c43d72983367498fcf52c5e695b34b6983e9c9c38321a82",
      tarballSha512:
        "1707e3ff2fea8e3ead4fed30e45a783c71bb54ce36a07823abb5b2b084cabcd752b0441aa3fa0f6a77ebc044dcbe04fc347dfc233b186bab36ef9133488c3743",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-nQMQLNYFEyXnoQHvl+8beqGPlDuxfWqPZ0uKtnjDDPGa1GjhKhGTyIZvHjxwrZkc3di/gwDlQKcDsbWBGihpCg==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/cli",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 905987,
      status: "present",
      tarballSha256: "fe382e5389de7be297ef75aec79bb9544500360de027346522d2da5556e00f3f",
      tarballSha512:
        "9d03102cd6051325e7a101ef97ef1b7aa18f943bb17d6a8f674b8ab678c30cf19ad468e12a1193c8866f1e3c70ad991cddd8bf8300e540a703b1b5811a28690a",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-dcXMzhVDlCrhJG6Oc8jNkhuT7UzFervnCBXXzsLZwruv7qMI5Wc2Is9KT1QWrck9hNdoCXMMUuqff/ay2+RPGQ==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/inspector",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 12316837,
      status: "present",
      tarballSha256: "4513206ccabda1bdc036b48a1b04e3bc0e1cb3f17345326097927d8e4fae0c17",
      tarballSha512:
        "75c5ccce1543942ae1246e8e73c8cd921b93ed4cc57abbe70815d7cec2d9c2bbafeea308e5673622cf4a4f5416adc93d84d76809730c52ea9f7ff6b2dbe44f19",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-ugxhAYpIR2ipS+QPwPEV5zSfx/vrQIUQciH5of2tagMvGKKFiUeTCz+QstpP2QsVEHzmoW39VU7fV4VDVw46bw==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/memory-pgvector",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 28308,
      status: "present",
      tarballSha256: "0615ebf95b77df8936ca3f8190ec2ebf5a7d2a908806199b739fefa22c2d34ef",
      tarballSha512:
        "ba0c61018a484768a94be40fc0f115e7349fc7fbeb4085107221f9a1fdad6a032f18a2858947930b3f90b2da4fd90b15107ce6a16dfd554edf578543570e3a6f",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-VdCa6a2uDhr2XDHJIbIspyIzB2Fx6FC/uIPYAzy9I7z5hy1fknwH3YIqmwLmjPSyFGRYPnWCX4sWKUVB6AZyPQ==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/testing",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 95537,
      status: "present",
      tarballSha256: "668f989d29ccdb8264c28b276e36fe0a5b54108319ddcdbcf425b602b03bd18b",
      tarballSha512:
        "55d09ae9adae0e1af65c31c921b22ca72233076171e850bfb883d8033cbd23bcf9872d5f927c07dd822a9b02e68cf4b21464583e75825f8b16294541e806723d",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-dGlQ3QDgAdmm6GwAkxoh0/L6MwwyIX8f3vyXhClt34mj7f0qaYNtqThnNDKALcwT2qjrsr2hyVOTRZTC8xVHlw==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/evals",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 41810,
      status: "present",
      tarballSha256: "a9f328b155db858661ef122e856801211423c257cdf56e51b9ebe49ce615a1b7",
      tarballSha512:
        "746950dd00e001d9a6e86c00931a21d3f2fa330c32217f1fdefc9784296ddf89a3edfd2a69836da938673432802dcc13daa8ebb2bda1c953934594c2f3154797",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-51RpuEZD7YBJJWj1kP5jUNFvSqFuTmEqw8N/DUfBAduR/s9s2UCtynLv5lK7/eoHQVpZSqzD5mrJvxSNMV+tGw==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "@b4run/vite-plugin",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 29313,
      status: "present",
      tarballSha256: "ec82c9661f459a1f8153038ac614bb28c404c2bde78e1285e1c84179fe860512",
      tarballSha512:
        "e75469b84643ed80492568f590fe6350d16f4aa16e4e612ac3c37f0d47c101db91fecf6cd940adca72efe652bbfdea07415a594aacc3e66ac9bf148d315fad1b",
      version: "0.15.5",
    },
    {
      integrity:
        "sha512-1bbAAEW//GHxD+xoFQtRckgNtheryXgGiXkEtn1zJwXnaP+Jza4m5THLojGfln1QQ1glZA8AxXIZc9VtoR/KRQ==",
      latest: {
        status: "present",
        version: "0.15.5",
      },
      name: "create-b4-app",
      provenance: {
        commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
        predicateType: "https://slsa.dev/provenance/v1",
        ref: "refs/tags/v0.15.5",
        repository: "https://github.com/cacheplane/b4run",
        workflow: ".github/workflows/release.yml",
      },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      size: 15775,
      status: "present",
      tarballSha256: "6599c4260ea825fd66e3ef7934b494aea6fc08140d03ff3078eeed812e2d3f24",
      tarballSha512:
        "d5b6c00045bffc61f10fec68150b5172480db617abc97806897904b67d732705e768ff89cdae26e531cba2319f967d50435825640f00c5721973d56da11fca45",
      version: "0.15.5",
    },
  ],
  schemaVersion: 1,
  status: "NPM_COMPLETE",
  version: "0.15.5",
}
export const TEST_OFFICIAL_AUDIT = {
  invalid: [],
  missing: [],
  verified: [
    {
      name: "create-b4-app",
      version: "0.15.5",
      location: "node_modules/create-b4-app",
      registry: "https://registry.npmjs.org/",
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/create-b4-app@0.15.5",
        provenance: {
          predicateType: "https://slsa.dev/provenance/v1",
        },
      },
      attestationBundles: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: {
            mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
            verificationMaterial: {
              certificate: {
                rawBytes:
                  "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",
              },
              tlogEntries: [
                {
                  logIndex: "3493037685",
                  logId: {
                    keyId: "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=",
                  },
                  kindVersion: {
                    kind: "dsse",
                    version: "0.0.1",
                  },
                  integratedTime: "1793038272",
                  inclusionPromise: {
                    signedEntryTimestamp:
                      "MEUCIQD3cDZU5DuwOYw1OGeNe8tF2e8N8YGKr7DisjyY0Jay+gIgZFcbiSW2gcg/3G/sE8QjaGJJMWS3gCyhbTOUZ5RV+L0=",
                  },
                  inclusionProof: {
                    logIndex: "3371133423",
                    rootHash: "SUoYjeArQnsUx/l1yirjAU7H4bXX+1RlPPUlUrRt42Y=",
                    treeSize: "3371134046",
                    hashes: [
                      "SJ0Ho6aPbzqCBUStctr0ogzCOkU46ERClkgaHNs0r9Y=",
                      "UcWsg5aCd4LrBpd5/UpVLYAIY5PW2xefhYoPPRfj2EY=",
                      "pT3vMLbI55jRIoKgr3zcmpmyQJMAMJ/k+dyyfiuoiiI=",
                      "xJfiIRZEmVupjZRwBOGdqzzLYe+79WnIROVm7sQRCtw=",
                      "N1bSAHXThQJdrvjwRNl9D1Ofgle6NDX2PQOkP4VAi5U=",
                      "83antPNRq9IsByW06bNUDqd+cIakAg+PleDkoWDOcWQ=",
                      "Bnqfir5ek8VZvUFk04sAD5xSeF0ExSywkh2erxovxMA=",
                      "d/RFoIwpDEqicupSKpXnaBgLwwInJkGTBU4uueN02DQ=",
                      "6/p304fqoNpfxq2/m8tDL5nfkRPe1pVtZ6ndYLFCS3g=",
                      "Zm81L5/hKZ8dPeJHn9+ldWOvlqjdWo1l2wOK9fUHnXA=",
                      "MaIrV+Bp11RKpVFDc5HLa07zb2K67YIvXSx6LnZ2KGQ=",
                      "FsXP4DcW7EuA5VwvhbPj9k61+VFxDHHO3fejvpt5oOQ=",
                      "EwFuCsA5VQwJ8RFSdym4X7Iv+VYku/R8Mb94NRdD/EM=",
                      "mpwzZtB2hFmz6YlbEPsasPUiY3lK37bf2VTYDz0zLGU=",
                      "nDLxq449iWX7ZE2onmGFFMm0VpMvb/CtYJYZR34v7KI=",
                      "CAmcXkQUGKPd/nXeW1UlMhcUjDN1AdFIpwvlHqw4rNU=",
                      "hKeYzFIP3U5xOP+FisEP5llLCQSMlk93Rlulr1Tea3Y=",
                      "Wnz0rGdtTkA3XsovdvhMLlaFNhZ8SXTlrwXUMEve9qY=",
                      "MyjrJwM9Dk7h6IPA4mUf5+I4RYvUDncpOMgvnfs1HIo=",
                      "aaVI67d/OrqvN4xcsDu/W6P1GzwKNHKO1xEdy7q2CqA=",
                      "TY3d2drTwuda9ZBHm8pW2WG8/oHifhFRUVa9Xdi4iXo=",
                      "zGfeoWKmrZlXMOvyi3R2GDbGpmI1skJW/wLTXCCgF0o=",
                      "1DaDKzrCNNBhmSdY5vFjz+NpAmxmYfYEgBCdPLrMP1A=",
                      "xH/DCseLHr9eKoYT8qsORZK7zVdEGYWHuVtsVrD95wY=",
                    ],
                    checkpoint: {
                      envelope:
                        "rekor.sigstore.dev - 1193050959916656506\n3371134046\nSUoYjeArQnsUx/l1yirjAU7H4bXX+1RlPPUlUrRt42Y=\n\n\u2014 rekor.sigstore.dev wNI9ajBFAiEA/pXIQRO2ZmZvId1qeXuSkRXHPPt/TTcLSyFu8GoZM5oCIG3sRNliTiPMTfaTl/OcA5WvSDWLA8OvogBXC24R57OA\n",
                    },
                  },
                  canonicalizedBody:
                    "eyJhcGlWZXJzaW9uIjoiMC4wLjEiLCJraW5kIjoiZHNzZSIsInNwZWMiOnsiZW52ZWxvcGVIYXNoIjp7ImFsZ29yaXRobSI6InNoYTI1NiIsInZhbHVlIjoiYjZjODUzMGJmODA1NmM1MzkxMWQyOTNhNjYwYmIxYzAyNjdmNDQyYjM0MDVjMTdmY2M1NDU4ODQ1ZWEyNTE3NCJ9LCJwYXlsb2FkSGFzaCI6eyJhbGdvcml0aG0iOiJzaGEyNTYiLCJ2YWx1ZSI6IjVlZDQ2NTEwOTRkNzgyNDlhNDU0MjM1MTRjNWU5YmUzZmY4OWQ4NTM0ZDFmNjc1ZGM2Y2U3YmI1YzI1OWNlNjYifSwic2lnbmF0dXJlcyI6W3sic2lnbmF0dXJlIjoiTUVVQ0lCcDNxYVQzYVB1dktBNDdobWV2bnptRWY3UU85SE9IRFllN1hHN1I1bE9LQWlFQTY5a3Q2NHZ1YjhsWGY4NFcwNzJCdWpFd3FXaTJTelR2WTlMWm9IcEV1dTA9IiwidmVyaWZpZXIiOiJMUzB0TFMxQ1JVZEpUaUJEUlZKVVNVWkpRMEZVUlMwdExTMHRDazFKU1VjcmFrTkRRbTlEWjBGM1NVSkJaMGxWVEdGTlVGUmpTVTFZY1ZJMFpEZHVRVmd2ZVdsQmQxSTNTekF3ZDBObldVbExiMXBKZW1vd1JVRjNUWGNLVG5wRlZrMUNUVWRCTVZWRlEyaE5UV015Ykc1ak0xSjJZMjFWZFZwSFZqSk5ValIzU0VGWlJGWlJVVVJGZUZaNllWZGtlbVJIT1hsYVV6RndZbTVTYkFwamJURnNXa2RzYUdSSFZYZElhR05PVFdwWmVFMUVTVEpOVkdkNFRWUkZlRmRvWTA1TmFsbDRUVVJKTWsxVVozbE5WRVY0VjJwQlFVMUdhM2RGZDFsSUNrdHZXa2w2YWpCRFFWRlpTVXR2V2tsNmFqQkVRVkZqUkZGblFVVkxXRXBHYWtKR1RHODBiME5GZUVNM1pYVkpaRUV4VEd0SWExbHBZM2d5ZEZKUFIwY0tNVFZ4ZVcxeVFrTlVaRlpuZUUxSmVHTlZVblZqVWxoU1ZrNVFVM2gwT1dweGQwZFNlRkowZUhsbGN5ODVLM2h3Y0RaUFEwSmFPSGRuWjFkaVRVRTBSd3BCTVZWa1JIZEZRaTkzVVVWQmQwbElaMFJCVkVKblRsWklVMVZGUkVSQlMwSm5aM0pDWjBWR1FsRmpSRUY2UVdaQ1owNVdTRk5OUlVkRVFWZG5RbFJtQ2pBcmJsQldhVkZTYkhadGJ6SlBhMjlXWVV4SFRHaG9hMUI2UW1oQ1owNVdTRkpGUWtGbU9FVldla0pXYUd4T2IyUklVbmRqZW05MlRESmtjR1JIYURFS1dXazFhbUl5TUhaWk1rWnFZVWRXZDJKSFJuVmFVemxwVGtoS01XSnBPSFZhTW13d1lVaFdhVXd6WkhaamJYUnRZa2M1TTJONU9YbGFWM2hzV1ZoT2JBcE1ibXgwWWtWQ2VWcFhXbnBNTTFKb1dqTk5kbVJxUVhWTlZGVjFUbFJCTlVKbmIzSkNaMFZGUVZsUEwwMUJSVUpDUTNSdlpFaFNkMk42YjNaTU0xSjJDbUV5Vm5WTWJVWnFaRWRzZG1KdVRYVmFNbXd3WVVoV2FXUllUbXhqYlU1MlltNVNiR0p1VVhWWk1qbDBUVUk0UjBOcGMwZEJVVkZDWnpjNGQwRlJTVVVLUlZoa2RtTnRkRzFpUnpreldESlNjR016UW1oa1IwNXZUVVJaUjBOcGMwZEJVVkZDWnpjNGQwRlJUVVZMUkdjelRqSk9iRTVFWnpWUFZGRjNUbTFPYkFwWmJVWnBXWHBGTVUxSFZUUk5SRTEzVDFkT2FVNVhVbWxhYWtsNVQxUnNhVnBYVlhkR1VWbExTM2RaUWtKQlIwUjJla0ZDUWtGUlNGVnRWbk5hVjBaNkNscFVRV1ZDWjI5eVFtZEZSVUZaVHk5TlFVVkdRa0pDYWxsWFRtOWFXRUp6V1ZjMWJFd3lTVEJqYmxaMVRVSTRSME5wYzBkQlVWRkNaemM0ZDBGUldVVUtSVmhLYkZwdVRYWmtSMFp1WTNrNU1rMUROSGhPVXpReFRVUnpSME5wYzBkQlVWRkNaemM0ZDBGUlowVk1VWGR5WVVoU01HTklUVFpNZVRrd1lqSjBiQXBpYVRWb1dUTlNjR0l5TlhwTWJXUndaRWRvTVZsdVZucGFXRXBxWWpJMU1GcFhOVEJNYlU1MllsUkNha0puYjNKQ1owVkZRVmxQTDAxQlJVcENSbFZOQ2xVeWFEQmtTRUo2VDJrNGRsb3liREJoU0ZacFRHMU9kbUpUT1dwWlYwNXZXbGhDYzFsWE5XeE1Na2t3WTI1V2RVeDVOVzVoV0ZKdlpGZEpkbVF5T1hrS1lUSmFjMkl6WkhwTU0wcHNZa2RXYUdNeVZYVmxWekZ6VVVoS2JGcHVUWFprUjBadVkzazVNazFETkhoT1V6UXhUVVJuUjBOcGMwZEJVVkZDWnpjNGR3cEJVVzlGUzJkM2IwOUVZek5aTWxVd1QwUnJOVTVFUVRKWk1sWnBXVmRLYWsxVVZYZGFWR2QzVFhwQk5Wa3lTVEZhUjBwdFRXcEpOVTlYU214YVZFRmtDa0puYjNKQ1owVkZRVmxQTDAxQlJVeENRVGhOUkZka2NHUkhhREZaYVRGdllqTk9NRnBYVVhkTmQxbExTM2RaUWtKQlIwUjJla0ZDUkVGUmJFUkRUbThLWkVoU2QyTjZiM1pNTW1Sd1pFZG9NVmxwTldwaU1qQjJXVEpHYW1GSFZuZGlSMFoxV2xNNWFVNUlTakZpYWtFMFFtZHZja0puUlVWQldVOHZUVUZGVGdwQ1EyOU5TMFJuTTA0eVRteE9SR2MxVDFSUmQwNXRUbXhaYlVacFdYcEZNVTFIVlRSTlJFMTNUMWRPYVU1WFVtbGFha2w1VDFSc2FWcFhWWGRKVVZsTENrdDNXVUpDUVVkRWRucEJRa1JuVVZSRVFrWjVXbGRhZWt3elVtaGFNMDEyWkdwQmRVMVVWWFZPVkVGaFFtZHZja0puUlVWQldVOHZUVUZGVUVKQmQwMEtRMnBGZVUxVVFYZE9la0Y1VDBSSmQweFJXVXRMZDFsQ1FrRkhSSFo2UVVKRlFWRm1SRUl4YjJSSVVuZGplbTkyVERKa2NHUkhhREZaYVRWcVlqSXdkZ3BaTWtacVlVZFdkMkpIUm5WYVZFRmFRbWR2Y2tKblJVVkJXVTh2VFVGRlVrSkJjMDFEVkVreVQxUk5lVTFxYXpKTlZFSnFRbWR2Y2tKblJVVkJXVTh2Q2sxQlJWTkNSbFZOVlRKb01HUklRbnBQYVRoMldqSnNNR0ZJVm1sTWJVNTJZbE01YWxsWFRtOWFXRUp6V1ZjMWJFd3lTVEJqYmxaMVRIazFibUZZVW04S1pGZEpkbVF5T1hsaE1scHpZak5rZWt3elNteGlSMVpvWXpKVmRXVlhNWE5SU0Vwc1dtNU5kbVJIUm01amVUa3lUVU0wZUU1VE5ERk5SR2RIUTJselJ3cEJVVkZDWnpjNGQwRlNUVVZMWjNkdlQwUmpNMWt5VlRCUFJHczFUa1JCTWxreVZtbFpWMHBxVFZSVmQxcFVaM2ROZWtFMVdUSkpNVnBIU20xTmFrazFDazlYU214YVZFRm9RbWR2Y2tKblJVVkJXVTh2VFVGRlZVSkNUVTFGV0dSMlkyMTBiV0pIT1ROWU1sSndZek5DYUdSSFRtOU5SbU5IUTJselIwRlJVVUlLWnpjNGQwRlNWVVZUVVhoSVlVaFNNR05JVFRaTWVUbHVZVmhTYjJSWFNYVlpNamwwVERKT2FGa3lhR3hqUjNob1ltMVZkbGxxVW5sa1Z6UjJXVmRPTUFwaFZ6bDFZM2s1ZVdSWE5YcE1lbEYzVFhwamQwMVVTVEZOYWtFelRESkdNR1JIVm5SalNGSjZUSHBGZDBabldVdExkMWxDUWtGSFJIWjZRVUpHWjFGSkNrUkJXbmRrVjBwellWZE5kMVZCV1V0TGQxbENRa0ZIUkhaNlFVSkhRVkpEUkVWQ2VWcFlRblpQYlU1b1dUSm9iR05IZUdoaWJWWkJUV3BaTlUxNlNYa0tUMVJaZUV3eVNUQmpibFoxVVVSRmVVMVVRWGRPZWtGNVQwUkpObU50Vm0xUGJrcHNXbTVOZG1SSFJtNWplVGt5VFVNMGVFNVROREZOU1VkTVFtZHZjZ3BDWjBWRlFXUmFOVUZuVVVOQ1NEQkZaWGRDTlVGSVkwRXpWREIzWVhOaVNFVlVTbXBIVWpSamJWZGpNMEZ4U2t0WWNtcGxVRXN6TDJnMGNIbG5Remh3Q2pkdk5FRkJRVWRvWlZkcVIwZG5RVUZDUVUxQlUwUkNSMEZwUlVGd1JUUXJhblJzU1daWE1FOXlOR3RaVTNFd1dWWkRiQzlHZW1seFRUWk1RMWROVFZFS09DOVhPRlpYWjBOSlVVTlRPSEJ4Um1kNlduWkdlVGt4ZVhGVFNqVkJlV2N3WmtWMmVWRk1lVmhaVm1SMk16VjNSa3N5Y1cxNlFVdENaMmR4YUd0cVR3cFFVVkZFUVhkT2IwRkVRbXhCYWtWQmF6TmxUV3RxVXl0elVqaENlVzlzVWk4M1ZqQmhUMlZpVkhVME1WVXhTbHBwYms0elRYRkxhRE5yT0hWbGMyZEpDbGRVWm5wRk1GcDBWemMxUVhCS1YwdEJha0ZETTFBNFkweEdiRmhsVm0xU2JUaHpRbmhGV0hFMk1VdFRiVEJaVXlzM2FrMXRhVzgxZERkTWNXTmtVM0VLTVZac2VuZzBjWFZVUlc5VmEwNVhTRVV5YXowS0xTMHRMUzFGVGtRZ1EwVlNWRWxHU1VOQlZFVXRMUzB0TFFvPSJ9XX19",
                },
              ],
              timestampVerificationData: {
                rfc3161Timestamps: [],
              },
            },
            dsseEnvelope: {
              payload:
                "eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEiLCJzdWJqZWN0IjpbeyJuYW1lIjoicGtnOm5wbS9jcmVhdGUtYjQtYXBwQDAuMTUuNSIsImRpZ2VzdCI6eyJzaGE1MTIiOiJkNWI2YzAwMDQ1YmZmYzYxZjEwZmVjNjgxNTBiNTE3MjQ4MGRiNjE3YWJjOTc4MDY4OTc5MDRiNjdkNzMyNzA1ZTc2OGZmODljZGFlMjZlNTMxY2JhMjMxOWY5NjdkNTA0MzU4MjU2NDBmMDBjNTcyMTk3M2Q1NmRhMTFmY2E0NSJ9fV0sInByZWRpY2F0ZVR5cGUiOiJodHRwczovL3Nsc2EuZGV2L3Byb3ZlbmFuY2UvdjEiLCJwcmVkaWNhdGUiOnsiYnVpbGREZWZpbml0aW9uIjp7ImJ1aWxkVHlwZSI6Imh0dHBzOi8vc2xzYS1mcmFtZXdvcmsuZ2l0aHViLmlvL2dpdGh1Yi1hY3Rpb25zLWJ1aWxkdHlwZXMvd29ya2Zsb3cvdjEiLCJleHRlcm5hbFBhcmFtZXRlcnMiOnsid29ya2Zsb3ciOnsicmVmIjoicmVmcy90YWdzL3YwLjE1LjUiLCJyZXBvc2l0b3J5IjoiaHR0cHM6Ly9naXRodWIuY29tL2NhY2hlcGxhbmUvYjRydW4iLCJwYXRoIjoiLmdpdGh1Yi93b3JrZmxvd3MvcmVsZWFzZS55bWwifX0sImludGVybmFsUGFyYW1ldGVycyI6eyJnaXRodWIiOnsiZXZlbnRfbmFtZSI6IndvcmtmbG93X2Rpc3BhdGNoIiwicmVwb3NpdG9yeV9pZCI6IjEyMTAwNzAyODIiLCJyZXBvc2l0b3J5X293bmVyX2lkIjoiMjY5MzIyOTYxIn19LCJyZXNvbHZlZERlcGVuZGVuY2llcyI6W3sidXJpIjoiZ2l0K2h0dHBzOi8vZ2l0aHViLmNvbS9jYWNoZXBsYW5lL2I0cnVuQHJlZnMvdGFncy92MC4xNS41IiwiZGlnZXN0Ijp7ImdpdENvbW1pdCI6Ijg3N2NlNDg5OTQwNmNlYmFiYzE1MGU4MDMwOWNiNWRiZjIyOTliZWUifX1dfSwicnVuRGV0YWlscyI6eyJidWlsZGVyIjp7ImlkIjoiaHR0cHM6Ly9naXRodWIuY29tL2FjdGlvbnMvcnVubmVyL2dpdGh1Yi1ob3N0ZWQifSwibWV0YWRhdGEiOnsiaW52b2NhdGlvbklkIjoiaHR0cHM6Ly9naXRodWIuY29tL2NhY2hlcGxhbmUvYjRydW4vYWN0aW9ucy9ydW5zLzQwMzcwMTI1MjA3L2F0dGVtcHRzLzEifX19fQ==",
              payloadType: "application/vnd.in-toto+json",
              signatures: [
                {
                  sig: "MEUCIBp3qaT3aPuvKA47hmevnzmEf7QO9HOHDYe7XG7R5lOKAiEA69kt64vub8lXf84W072BujEwqWi2SzTvY9LZoHpEuu0=",
                  keyid: "",
                },
              ],
            },
          },
          signedAccessSignatureUrl: "",
        },
      ],
    },
  ],
}
export const TEST_AUDIT_RECEIPT = {
  checks: [
    {
      conclusion: "success",
      detail: "The draft Release records this exact independent audit dispatch.",
      name: "release-dispatch-marker",
    },
    {
      conclusion: "success",
      detail: "The current GitHub run and attempt match the dispatched tag audit.",
      name: "workflow-run-attempt",
    },
    {
      conclusion: "success",
      detail: "The fixed release inventory was read from the immutable candidate commit.",
      name: "immutable-inventory",
    },
    {
      conclusion: "success",
      detail:
        "The production observer verified the durable candidate evidence without diagnostics.",
      name: "production-observation",
    },
    {
      conclusion: "success",
      detail: "The production planner permits only completion of this release audit.",
      name: "production-plan",
    },
  ],
  commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
  conclusion: "success",
  finishedAt: "2026-10-26T18:22:14.221Z",
  manifestSha256: "81b7df4408a73b1e236570cace34efbfdd9cea5848dc2f8145cd6d730c29429e",
  runAttempt: 1,
  schemaVersion: 1,
  startedAt: "2026-10-26T18:20:57.987Z",
  version: "0.15.5",
  workflowRunId: 40376822663,
}
export const TEST_CANDIDATE = {
  version: "0.15.5",
  commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
  publisherWorkflow: ".github/workflows/release.yml",
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

export function testRecord() {
  const incident = structuredClone(records.HISTORICAL_0155_INCIDENT)
  const start = "2026-10-27T12:00:00.000Z"
  const end = "2026-10-27T12:02:00.000Z"
  const run = (runId, workflow, jobName) => ({
    repository: incident.repository,
    repositoryId: incident.repositoryId,
    runId,
    runAttempt: 1,
    workflow,
    ref: incident.publisherRef,
    commitSha: incident.commitSha,
    status: "completed",
    conclusion: "success",
    jobs: [{ id: 123, name: jobName, status: "completed", conclusion: "success" }],
  })
  const archivePath = "scripts/release/historical-publications/evidence/v0.15.5/npm-evidence.zip"
  const receiptPath = "scripts/release/historical-publications/evidence/v0.15.5/npm-evidence.json"
  const originalAuditBytes = Buffer.from(`${JSON.stringify(TEST_AUDIT_RECEIPT, null, 2)}\n`)
  const auditDigest = sha256(originalAuditBytes)
  const packageRows = TEST_MANIFEST.packages.map((entry) => ({
    ...entry,
    verification: entry.name === "create-b4-app" ? "historical-provenance" : "complete",
  }))
  const auditReceipts = ["audit-result.json", "audit-attempt-40376822663-1.json"].map(
    (name, index) => ({
      id: index + 1,
      name,
      size: originalAuditBytes.length,
      sha256: auditDigest,
      receipt: structuredClone(TEST_AUDIT_RECEIPT),
    }),
  )
  return {
    schemaVersion: 1,
    policyRevision: records.HISTORICAL_PUBLICATION_POLICY_REVISION,
    incident,
    capture: {
      operator: { login: "fixture-operator", id: 456 },
      controllerSha: "a".repeat(40),
      startedAt: start,
      finishedAt: end,
    },
    original: {
      publisher: run(incident.publisherRunId, incident.publisherWorkflow, "publish-npm"),
      artifact: {
        id: incident.artifactId,
        name: incident.artifactName,
        runId: incident.publisherRunId,
        serviceDigest: incident.archiveServiceDigest,
        size: 100,
        sha256: incident.archiveServiceDigest.slice(7),
        path: archivePath,
      },
      npmEvidence: structuredClone(TEST_RECEIPT),
      audit: {
        run: run(incident.auditRunId, incident.auditWorkflow, "verify"),
        receipts: auditReceipts,
      },
    },
    brackets: [
      {
        observedAt: start,
        factsSha256: "b".repeat(64),
        releaseOwnersInactive: true,
      },
      {
        observedAt: end,
        factsSha256: "b".repeat(64),
        releaseOwnersInactive: true,
      },
    ],
    sweeps: [
      {
        startedAt: start,
        finishedAt: "2026-10-27T12:00:20.000Z",
        evidenceSha256: "c".repeat(64),
        packages: structuredClone(packageRows),
      },
      {
        startedAt: "2026-10-27T12:01:20.000Z",
        finishedAt: end,
        evidenceSha256: "d".repeat(64),
        packages: structuredClone(packageRows),
      },
    ],
    supportingEvidence: [
      {
        path: archivePath,
        size: 100,
        sha256: incident.archiveServiceDigest.slice(7),
      },
      {
        path: receiptPath,
        size: Buffer.byteLength(`${JSON.stringify(TEST_RECEIPT, null, 2)}\n`),
        sha256: incident.originalReceiptSha256,
      },
      ...auditReceipts.map((asset) => ({
        path: `scripts/release/historical-publications/evidence/v0.15.5/${asset.name}`,
        size: asset.size,
        sha256: asset.sha256,
      })),
      ...[
        ["bracket-before.json", "b"],
        ["bracket-after.json", "b"],
        ["sweep-first.json", "c"],
        ["sweep-second.json", "d"],
      ].map(([name, digit]) => ({
        path: `scripts/release/historical-publications/evidence/v0.15.5/${name}`,
        size: 100,
        sha256: digit.repeat(64),
      })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1)),
  }
}
