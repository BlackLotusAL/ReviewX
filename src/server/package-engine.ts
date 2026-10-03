// Built alongside the CLI so installed-package acceptance exercises the exact production engine.
export { GitPreparer } from "./integrations/git";
export { OpenCodeReviewer } from "./integrations/opencode";
export { freezeReviewRules } from "./review/rules";
export { resolveDataPaths, ensureDataPaths } from "./platform/paths";
