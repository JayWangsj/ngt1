# Windows Studio Release Ready

Release Ready qualifies one exact source commit before creating a release tag.
It requires the Verify MVP gates and the disposable Windows installer, repair,
and Rust online-update acceptance jobs to pass for that commit. The online
update test serves the exact candidate installer and assets through a local
mock GitHub Releases API, then verifies the installed version, commit, database,
and business data.

The versioned backup import job runs the supported business backup fixtures
against an isolated PostgreSQL database. It covers the legacy v1 and v9 formats,
the current v10 round trip, import rollback, and rejection of a repeated import.

The formal tagged-release workflow adds a standard-user production-updater
acceptance against the exact candidate Draft Release. It checks the Draft build
identity and asset hashes through an isolated `GH_CONFIG_DIR`, then verifies
that the packaged Rust updater downloads the exact installer, completes the
update, and preserves the business database and seeded business data. The
GitHub CLI token-source matrix runs in the Windows candidate build.

The workflows no longer require historical installer baselines or a separate
updater-test repository. Release Ready remains non-writing: it does not create
tags, Draft Releases, public Releases, or GitHub repository refs. The formal
tagged-release workflow retains the exact-SHA Verify MVP, Release Ready,
publication, and asset-integrity gates.
