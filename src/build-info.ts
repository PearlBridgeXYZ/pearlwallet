declare const __BUILD_GIT_SHA__: string;
declare const __BUILD_TIME__: string;

// BUILD_VERSION is kept in sync with package.json by a prebuild step
// (scripts/sync-version.mjs). Do not hand-edit — bump package.json and
// the next `npm run build` will rewrite this constant.
export const BUILD_VERSION = "0.3.1";

export const BUILD_GIT_SHA: string = __BUILD_GIT_SHA__;
export const BUILD_TIME: string = __BUILD_TIME__;

// Public source repo where the build originates. Footer links here so users
// can audit the exact commit they're running.
export const REPO_URL = "https://github.com/PearlBridgeXYZ/pearlwallet";
export const COMMIT_URL = `${REPO_URL}/commit/${BUILD_GIT_SHA}`;
