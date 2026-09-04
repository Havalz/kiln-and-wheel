/**
 * Refresh the Remote Service Gateway tokens.
 *
 * RSG tokens carry a ~1 hour TTL. When they expire, GlazeBenchVoice stops
 * getting real answers and silently drops to its offline preset fallback --
 * the symptom is every glaze suddenly coming back as a local preset with
 * "Network error" on the panel.
 *
 * Run with the ExecuteEditorCode MCP tool's `path` argument:
 *   ExecuteEditorCode({ path: "<project>/Tools/refresh-rsg-tokens.ts" })
 *
 * NOT a Lens script. It lives outside Assets/ on purpose so Lens Studio's
 * TypeScript compiler never tries to build it as part of the Lens.
 *
 * Generates all three providers every time. Generating only the one you think
 * you need is how you get a confusing silent failure the day you add a feature
 * that uses another provider.
 */

const Network: any = await import("LensStudio:Network");
const model = pluginSystem.findInterface(Editor.Model.IModel) as any;
const scene = model.project.scene as any;

/** Editor SceneObjects expose children as an array on some builds and via
 *  getChild/getChildrenCount on others. Handle both. */
function kids(obj: any): any[] {
  if (Array.isArray(obj.children)) return obj.children;
  if (typeof obj.getChildrenCount === "function") {
    const out: any[] = [];
    for (let i = 0; i < obj.getChildrenCount(); i++) out.push(obj.getChild(i));
    return out;
  }
  return [];
}

function findCred(): any {
  const stack: any[] = (scene.rootSceneObjects as any[]).slice();
  while (stack.length) {
    const o = stack.pop();
    for (const c of (o.components ?? [])) {
      const n = String((c as any).name ?? "");
      const t = String((c as any).type ?? "");
      if (n.includes("RemoteServiceGatewayCredentials") ||
          t.includes("RemoteServiceGatewayCredentials")) {
        return {comp: c, owner: o};
      }
    }
    for (const k of kids(o)) stack.push(k);
  }
  return null;
}

function gen(type: string): Promise<string> {
  const req = new Network.HttpRequest();
  req.url = `https://gcp.api.snapchat.com/smart-gate/v2/token/${type}`;
  req.method = Network.HttpRequest.Method.Post;
  return new Promise((resolve, reject) => {
    // Authorized request: the user's Lens Studio sign-in is injected for us,
    // so there is no API key and no OAuth prompt.
    Network.performAuthorizedHttpRequest(req, (r: any) => {
      if (r.statusCode === 200) {
        try { resolve(JSON.parse(r.body).token); }
        catch (e) { reject(`${type}: unparseable token response`); }
      } else {
        reject(`${type}: HTTP ${r.statusCode}`);
      }
    });
  });
}

const found = findCred();
if (!found) {
  return {
    ok: false,
    error: "RemoteServiceGatewayCredentials component not found in the scene."
  };
}

// A disabled ancestor means the component never runs, so the tokens would be
// written but never read. Worth reporting rather than silently succeeding.
let ancestorDisabled: string = null;
{
  let p = found.owner;
  while (p) {
    if (p.enabled === false) { ancestorDisabled = p.name; break; }
    p = p.parent ?? null;
  }
}

try {
  const [snapToken, openAIToken, googleToken] = await Promise.all([
    gen("SNAP"), gen("OPENAI"), gen("GOOGLE")
  ]);
  found.comp.snapToken = snapToken;
  found.comp.openAIToken = openAIToken;
  found.comp.googleToken = googleToken;
  model.project.save();
  return {
    ok: true,
    refreshed: ["SNAP", "OPENAI", "GOOGLE"],
    owner: found.owner.name,
    warning: ancestorDisabled
      ? `Tokens written, but ancestor "${ancestorDisabled}" is DISABLED — the credentials component will not run.`
      : null,
    note: "Saved. Tokens expire again in ~1 hour."
  };
} catch (e) {
  return { ok: false, error: String(e) };
}
