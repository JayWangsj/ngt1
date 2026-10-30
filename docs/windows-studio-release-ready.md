# Windows Studio Release Ready test repository

Release Ready uses a dedicated **public** test repository so the production
repository `JayWangsj/ngt1` is never modified by the updater acceptance. The
repository must use `main`, match the approved repository name exactly, and
contain no unrelated branches, tags, or Releases. Do not initialize it with a
README or add unrelated content.

## GitHub configuration

In the `ngt-updater-test` Environment:

- Allow deployment only from the trusted `master` branch and retain the
  repository's required review and self-review protections.
- Set the non-secret Environment variable `NGT_UPDATER_TEST_REPOSITORY` to the
  exact public `owner/repository` name. The workflow's manual input must match
  this value; the input alone cannot select an arbitrary repository.
- Set the Environment secret `NGT_UPDATER_TEST_TOKEN` to a fine-grained token
  selected for this repository only, with `Contents: Read and write`. Do not
  grant write access to `JayWangsj/ngt1` or unrelated repositories.

Git ref pushes and Release creation/upload require repository Contents write.
The production updater reads the token through an isolated `GH_CONFIG_DIR`;
the workflow does not persist it in the standard user's profile or expose it
as a command-line argument.

## Public data and Draft handling

The workflow mirrors the already-published v2.0.21 source tag and Release
assets, then points `main` and the v2.0.23 candidate tag at the exact qualified
public `master` commit. These source objects and the published baseline assets
are public. Never add secrets, temporary credentials, machine configuration,
or business test data to this repository or its refs.

The v2.0.21 baseline Release is published so the original production updater
can discover the baseline. The exact-SHA v2.0.23 candidate Release must remain
a Draft throughout acceptance. The scoped token gives the updater access to
that Draft and its assets; publishing it to make it readable is prohibited.
Release Ready rejects unrelated Releases, mismatched refs or tags, altered
baseline assets, and an already-published candidate. It does not overwrite or
delete conflicting content.

Keep the repository and its Releases for audit unless a maintainer separately
approves cleanup. Never reuse it after adding unrelated refs or Releases.
