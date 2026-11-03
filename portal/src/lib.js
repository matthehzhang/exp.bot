// Pure helpers (tested in tests/lib.test.js).

// A machine checks in every 30 s; it is online if seen within 90 s, late within 10 min.
export function machineState(lastSeenAt, now = Date.now()) {
  if (!lastSeenAt) return "never";
  const age = (now - Date.parse(lastSeenAt)) / 1000;
  if (age < 90) return "online";
  if (age < 600) return "late";
  return "offline";
}

// The state's word and its pill / lamp class, in the app's colours (green fine, amber caution).
export const STATE = {
  online: { word: "Online", cls: "ok" },
  late: { word: "Late", cls: "warn" },
  offline: { word: "Offline", cls: "" },
  never: { word: "Not linked", cls: "" },
};

export function ago(iso, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function bytes(n) {
  if (n == null) return "";
  const u = ["B", "kB", "MB", "GB"];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function text(v) {
  if (v == null || v === "") return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const CLASSES = new Set(["ok", "run", "warn", "pow", "bad", "rec", "save", ""]);

// A machine's lamps, as its own app shows them: the rig app sends its status lamps
// (status.lamps: [{k, cls, word, detail}], expbot/app/fleet.py); without them, the fields it sent.
export function lampsFor(status) {
  const st = status || {};
  if (Array.isArray(st.lamps)) {
    return st.lamps.slice(0, 24).map((x, i) => ({
      k: text(x.k) || String(i),
      cls: CLASSES.has(x.cls) ? x.cls : "",
      word: text(x.word),
      detail: text(x.detail),
    }));
  }
  const out = [];
  const add = (k, word, detail, cls = "") => detail && out.push({ k, word, detail, cls });
  add("job", "Job", text(st.job) || "none", st.job ? "run" : "");
  add("arms", "Arms", text(st.arms));
  add("cameras", "Cameras", text(st.cameras));
  add("calibration", "Calibration", text(st.calibration));
  return out;
}

// The worst lamp decides a machine's line on the fleet: a fault, then a caution, then a job.
const RANK = { bad: 3, rec: 2, warn: 1, pow: 1 };
export function worstLamp(lamps) {
  let worst = null;
  for (const l of lamps) if ((RANK[l.cls] || 0) > (RANK[worst?.cls] || 0)) worst = l;
  return worst;
}

// The fleet's state for the page's head: one word, its class, one sentence.
export function fleetSummary(machines, now = Date.now()) {
  const n = { online: 0, late: 0, offline: 0, never: 0, faults: 0, jobs: 0 };
  for (const m of machines) {
    const s = machineState(m.last_seen_at, now);
    n[s]++;
    if (s !== "online") continue;
    const lamps = lampsFor(m.status);
    if (lamps.some((l) => l.cls === "bad")) n.faults++;
    if (m.status?.job) n.jobs++;
  }
  const total = machines.length;
  const down = n.late + n.offline + n.never;
  let word, cls;
  if (!total) { word = "No machines"; cls = ""; }
  else if (n.faults) { word = n.faults === 1 ? "A fault" : `${n.faults} faults`; cls = "bad"; }
  else if (!n.online) { word = "All offline"; cls = "warn"; }
  else if (down) { word = `${down} not online`; cls = "warn"; }
  else { word = "All online"; cls = "ok"; }
  const parts = [`${total} machine${total === 1 ? "" : "s"}`];
  if (total) parts.push(`${n.online} online`);
  if (n.jobs) parts.push(`${n.jobs} running a job`);
  return { word, cls, sentence: total ? parts.join(" · ") : "Add one below and link it from its own app.", n };
}

// Hash routes: #/ , #/org/<id>/<tab> , #/org/<id>/machine/<machineId>
export function parseRoute(hash) {
  const parts = (hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] !== "org" || !parts[1]) return { page: "home" };
  if (parts[2] === "machine" && parts[3]) return { page: "machine", org: parts[1], machine: parts[3] };
  return { page: "org", org: parts[1], tab: ["fleet", "members", "files"].includes(parts[2]) ? parts[2] : "fleet" };
}
