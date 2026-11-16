/** Pure policy shared with the disposable Compose builder's startup checks. */
export function assertImageVersion(state, options = {}) {
  const fail = code => { throw Object.assign(Error(code), { code }); };
  if (!/^[a-f0-9]{40}$/.test(state.sha ?? '')) fail('INVALID_SHA');
  if (state.branch !== 'main' && !options.allowNonMain) fail('MAIN_REQUIRED');
  if (state.dirty && !options.allowDirty) fail('CLEAN_TREE_REQUIRED');
  return state.sha;
}
