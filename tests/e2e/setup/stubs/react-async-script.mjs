/**
 * Test stub for `react-async-script`. react-ui's RecaptchaWrapper calls
 * `makeAsyncScriptLoader(url, opts)(ReCaptcha)` at module load; the real CJS module's default export
 * has esbuild/Node interop issues in the e2e prebundle. The e2e sync tests never render reCAPTCHA, so a
 * no-op HOC loader (returns the wrapped component unchanged) is sufficient and avoids the interop failure.
 */
export default function makeAsyncScriptLoader() {
  return (Component) => Component;
}
