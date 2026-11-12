# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub Security Advisories:
https://github.com/q253595422/dsh-imagegen-video/security/advisories/new

Please do not open a public issue for a vulnerability. Include the affected
version (`package.json` `version`), the DSH version, the steps to reproduce, and
what an attacker gains. You can expect an initial reply within seven days.

## Scope

This plugin runs inside the DeepSeek Harness host and, in the same process,
handles provider credentials, the local gallery, canvas files, and the
`ffmpeg` subprocess used for clip stitching. Reports about the following are in
scope:

- credential handling: channel API keys, OAuth tokens for subscription vendors,
  and anything the redaction layer in diagnostics is supposed to remove
- path handling for the gallery, canvas files, template archives, and skill
  archives (traversal, symlink escape, overwriting a file outside the data dir)
- the HTTP surface the plugin adds to the host web server (route authorization,
  cross-origin access, unauthenticated state changes)
- subprocess invocation (`ffmpeg`, archive extraction) with attacker-controlled
  arguments

Host-level vulnerabilities that reproduce without this plugin belong in the
DeepSeek Harness tracker instead.

## Supported versions

Only the current npm release line receives fixes. `1.27.x` is supported; older
versions are not patched, and the fix ships as a patch release on the current
line.

## Credentials in this repository

No real credential is stored here. Test suites use obvious placeholders
(`sk-video`, `test-google-key`, `key-of-a`, …) against local stub servers bound
to `127.0.0.1`. If you find anything in this repository that looks like a live
key, treat it as a leak and report it through the advisory link above.
