// The release version, kept in lockstep with package.json and SKILL.md by
// scripts/sync-version.mjs when semantic-release cuts a release.
//
// Not named `VERSION`: the vendored ultraindex engine exports that name (its
// own version), and `webindex skill check` refuses a module that declares a
// name the engine already exports.
export const ULTRAVIEW_VERSION = "1.4.0";
