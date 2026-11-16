# Archived: native node:test suite

This directory is archived and not maintained.

It holds the `node:test` cases that used to live next to the sources in
`integrations/native/` (39 files, 277 cases). They were moved here verbatim
and are not part of CI or of any npm script. Some of them need external
source trees or private directories that are not in this repository, so they
do not pass offline, and they are not expected to run from this location
(their relative imports still point at the parent directory).

Do not fix or extend these tests. The maintained gates are the Vitest unit
tests under `tests/` (`npm run test:ci`), the PostgreSQL integration tests
(`npm run test:pg`) and the mutation checks.

See #12.
