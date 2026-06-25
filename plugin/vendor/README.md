# Vendored sql.js

Pinned copy of [sql.js](https://github.com/sql-js/sql.js) (MIT). Used by the
plugin's local SQLite reads where the native binary is unavailable.

## Pinned release: v1.14.1

| File          | SHA256                                                           |
| ------------- | ---------------------------------------------------------------- |
| sql-wasm.js   | `77d6435bac506af0e3c59636dce9d22b1b14156348bc327f41a1577f3212360f` |
| sql-wasm.wasm | `438c88f666dc054ce4e9395f80fe9db4218b1a3c379960454880f048a7898aed` |

Verify after any bump:

```
shasum -a 256 sql-wasm.js sql-wasm.wasm
```

Upstream: https://github.com/sql-js/sql.js/releases/tag/v1.14.1

## How the version was determined

The vendored files carry no in-file version banner. I matched the SHA256
digests against every npm release of sql.js (v1.2.2 – v1.14.1) by unpacking
each release tarball and hashing its `dist/sql-wasm.js` and `dist/sql-wasm.wasm`
files. Only `sql.js@1.14.1` produced both matching digests.
