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

## Workshop qualification for v2.0.25

The `windowsPrereleaseVersion` entry in package.json holds this exact version's
verified assets in a private Draft. It does not publish a prerelease. Use the
installer from that Draft for both real Windows checks, then publish that same
Draft as a stable release. Record the tagged commit and installer SHA256 before
testing and check both again before publication. Do not rebuild or replace assets
after workshop qualification.

- On clean Win10 22H2 x64, install offline as a standard user. Verify no login
  startup entry and that the desktop entry starts the application on demand.
- On a disposable copy of the workshop state, use the real v2.0.23 and v2.0.24
  installers to reproduce the failed upgrade, then run the Draft installer and
  verify the active version, database and Windows registration. Run the legacy
  updater handoff separately. Keep the actual business JSON in the workshop's
  isolated environment and record the import outcome and business reconciliation.
- Interrupt preparation, migration, database recovery and Windows registration
  separately. Compare the operation ID, version, backup and terminal result.
  Check drag/minimize responsiveness throughout installation and record three
  comparable runs on the same machine.

Cloud acceptance uses a disposable hosted runner and a synthetic update
baseline. Both real Windows checks are required before the Draft is published.
