// The fleet portal (app.exp.bot), in the rig app's design language: its top bar, white panels,
// a page's state as one large word and one plain sentence, lamps for status, the pinwheel for
// waiting, its question plate for anything that needs an answer.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader, Mark, Wordmark } from "./brand.jsx";
import { must, sb } from "./supabase.js";
import { ago, bytes, fleetSummary, lampsFor, machineState, parseRoute, STATE, worstLamp } from "./lib.js";

const BUCKET = "org-files";
const LINK_CMD = (token) => `python -m expbot.app.ctl fleet link ${token}`;
const NAME_RE = "[A-Za-z0-9][A-Za-z0-9._\\-]{0,62}";

// ── small pieces ────────────────────────────────────────────────────────────────────────

function useNow(ms = 10000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function useRoute() {
  const [route, setRoute] = useState(parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

// Runs an async action, keeping its error and busy state.
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

function Err({ error }) {
  return error ? <p className="err" role="alert">{String(error.message || error)}</p> : null;
}

function Pill({ state }) {
  const s = STATE[state];
  return <span className={`pill ${s.cls}`}>{s.word}</span>;
}

function Lamps({ lamps }) {
  return (
    <div className="lamps">
      {lamps.map((l) => (
        <span key={l.k} className={`lamp ${l.cls}`}><i className="led" /><b>{l.word}</b><span className="lv">{l.detail}</span></span>
      ))}
    </div>
  );
}

// The app's question plate: a mark, a title, the text, the answers on the right.
function Plate({ title, sub, warn, children, actions, onClose }) {
  useEffect(() => {
    const on = (e) => e.key === "Escape" && onClose?.();
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${warn ? " warn" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mhead"><Mark /><div className="eyebrow">{title}{sub && <span className="sub">{sub}</span>}</div></div>
        <div className="text">{children}</div>
        {actions && <div className="row">{actions}</div>}
      </div>
    </div>
  );
}

// window.confirm, as the app's plate. ask({title, text, yes, danger}) -> Promise<boolean>
function useConfirm() {
  const [q, setQ] = useState(null);
  const ask = useCallback((o) => new Promise((resolve) => setQ({ ...o, resolve })), []);
  const done = (v) => { q.resolve(v); setQ(null); };
  const plate = q && (
    <Plate title={q.title} warn={q.danger} onClose={() => done(false)}
      actions={<>
        <button onClick={() => done(false)}>Cancel</button>
        <button className={q.danger ? "danger" : "primary"} onClick={() => done(true)} autoFocus>{q.yes || "OK"}</button>
      </>}>
      <p>{q.text}</p>
    </Plate>
  );
  return [ask, plate];
}

function Copy({ text, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={async () => {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }}>{done ? "Copied" : label}</button>
  );
}

// ── the top bar ─────────────────────────────────────────────────────────────────────────

function Rail({ route, orgs, email, summary }) {
  const org = orgs?.find((o) => o.id === route.org);
  const tab = route.page === "machine" ? "fleet" : route.tab;
  return (
    <header className="rail">
      <div className="rail-top">
        <a className="brand" href="#/" aria-label="exp fleet: your orgs"><Mark /><Wordmark /><span className="place">fleet</span></a>
        <nav className="modes" aria-label="Pages">
          {org ? ["fleet", "members", "files"].map((t) => (
            <a key={t} className={`tab${tab === t ? " active" : ""}`} href={`#/org/${org.id}/${t}`}
              aria-current={tab === t ? "page" : undefined}>{t[0].toUpperCase() + t.slice(1)}</a>
          )) : <a className={`tab${route.page === "home" ? " active" : ""}`} href="#/">Orgs</a>}
        </nav>
        <div className="railend">
          {orgs && orgs.length > 0 && (
            <select className="orgpick" aria-label="Org" value={org?.id || ""}
              onChange={(e) => { location.hash = e.target.value ? `#/org/${e.target.value}` : "#/"; }}>
              <option value="">All orgs</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          {summary && (
            <span className={`sysbtn ${summary.cls}`} role="status"><i className="dot" /><span>{summary.word}</span></span>
          )}
          <div className="verchip">
            <span className="vtx" title={email}>{email}</span>
            <button className="link" onClick={() => sb.auth.signOut()}>Sign out</button>
          </div>
        </div>
      </div>
    </header>
  );
}

// ── sign in ─────────────────────────────────────────────────────────────────────────────

function Gate({ children }) {
  return (
    <main className="gate">
      <div className="wrap">
        <div className="lockup"><Mark /><Wordmark /></div>
        {children}
      </div>
    </main>
  );
}

function SignIn() {
  const [mode, setMode] = useState("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction();
  const title = { in: "Sign in", up: "Make an account", reset: "Reset the password" }[mode];

  const submit = (e) => {
    e.preventDefault();
    setNote("");
    run(async () => {
      if (mode === "in") {
        await must(sb.auth.signInWithPassword({ email, password }));
      } else if (mode === "up") {
        const data = await must(sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } }));
        if (!data.session) setNote("Confirm the account from the email we sent, then sign in.");
      } else {
        await must(sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin }));
        setNote("If that address has an account, a link to reset it is on its way.");
      }
    });
  };
  const other = (m, label) => mode !== m && (
    <button type="button" className="link" onClick={() => { setMode(m); setNote(""); }}>{label}</button>
  );

  return (
    <Gate>
      <div className="modal">
        <div className="mhead"><Mark /><div className="eyebrow">{title}</div></div>
        <div className="text">The fleet: every rig and GPU PC of your org, their state and their files.</div>
        <form onSubmit={submit}>
          <label className="param">Email<input type="email" required autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} /></label>
          {mode !== "reset" && (
            <label className="param">Password<input type="password" required minLength={8} value={password}
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              onChange={(e) => setPassword(e.target.value)} /></label>
          )}
          <button className="primary big" disabled={busy}>
            {mode === "in" ? "Sign in" : mode === "up" ? "Make the account" : "Send the link"}</button>
          <Err error={error} />
          {note && <p className="note">{note}</p>}
          <div className="alt">{other("in", "Sign in")}{other("up", "Make an account")}{other("reset", "Forgot the password")}</div>
          <p className="help">Anyone can make an account; you see only the orgs you make or are invited to.</p>
        </form>
      </div>
    </Gate>
  );
}

function SetPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Gate>
      <div className="modal">
        <div className="mhead"><Mark /><div className="eyebrow">A new password</div></div>
        <form onSubmit={(e) => {
          e.preventDefault();
          run(async () => { await must(sb.auth.updateUser({ password })); onDone(); });
        }}>
          <label className="param">New password<input type="password" required minLength={8} autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="primary big" disabled={busy}>Save it</button>
          <Err error={error} />
        </form>
      </div>
    </Gate>
  );
}

// ── orgs ────────────────────────────────────────────────────────────────────────────────

function Home({ orgs, reloadOrgs }) {
  const [invites, setInvites] = useState(null);
  const [name, setName] = useState("");
  const { busy, error, run } = useAction();

  const loadInvites = useCallback(() => run(async () => setInvites(await must(sb.rpc("my_invites")))), [run]);
  useEffect(() => { loadInvites(); }, [loadInvites]);

  return (
    <main className="page">
      <section>
        <div className="hero">
          <div>
            <div className="eyebrow">Orgs</div>
            <div className="hero-word">{orgs.length ? `${orgs.length} org${orgs.length === 1 ? "" : "s"}` : "No org yet"}</div>
            <p className="lede">{orgs.length ? "Pick one for its fleet, its people and its files."
              : "Make one for your rigs, or ask an org's owner to invite this email."}</p>
          </div>
        </div>
      </section>
      {invites?.length > 0 && (
        <section>
          <h2>Invitations</h2>
          <div className="rows">
            {invites.map((i) => (
              <div className="rowline" key={i.id}>
                <span className="who"><b>{i.org_name}</b>
                  <span className="muted">as {i.role}{i.invited_by_email ? `, from ${i.invited_by_email}` : ""} · {ago(i.created_at)}</span></span>
                <span className="acts">
                  <button className="primary small" disabled={busy} onClick={() => run(async () => {
                    const org = await must(sb.rpc("accept_invite", { p_invite: i.id }));
                    await reloadOrgs();
                    location.hash = `#/org/${org}`;
                  })}>Join</button>
                  <button className="small" disabled={busy} onClick={() => run(async () => {
                    await must(sb.from("org_invites").delete().eq("id", i.id));
                    await loadInvites();
                  })}>Decline</button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <h2>Your orgs</h2>
        {orgs.length > 0 && (
          <div className="rows">
            {orgs.map((o) => (
              <div className="rowline" key={o.id}>
                <span className="who"><a className="name" href={`#/org/${o.id}`}>{o.name}</a></span>
                <span className="pill">{o.role}</span>
              </div>
            ))}
          </div>
        )}
        <form className="row" style={{ marginTop: orgs.length ? 14 : 0 }} onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const id = await must(sb.rpc("create_org", { p_name: name }));
            setName("");
            await reloadOrgs();
            location.hash = `#/org/${id}`;
          });
        }}>
          <input type="text" className="grow" placeholder="A new org's name" required maxLength={80} value={name}
            onChange={(e) => setName(e.target.value)} aria-label="New org name" />
          <button className="primary" disabled={busy}>Make the org</button>
        </form>
        <Err error={error} />
      </section>
    </main>
  );
}

// ── fleet ───────────────────────────────────────────────────────────────────────────────

function useMachines(orgId) {
  const [machines, setMachines] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("machines").select("*").eq("org_id", orgId).order("name");
    if (error) setError(error); else { setError(null); setMachines(data); }
  }, [orgId]);

  useEffect(() => {
    setMachines(null);
    load();
    const ch = sb.channel(`machines:${orgId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "machines", filter: `org_id=eq.${orgId}` },
        (p) => setMachines((ms) => {
          if (!ms) return ms;
          if (p.eventType === "DELETE") return ms.filter((m) => m.id !== p.old.id);
          const rest = ms.filter((m) => m.id !== p.new.id);
          return [...rest, p.new].sort((a, b) => a.name.localeCompare(b.name));
        }))
      .subscribe();
    // Live updates when the socket is up; a refresh every 15 s in case it is not.
    const t = setInterval(load, 15000);
    return () => { clearInterval(t); sb.removeChannel(ch); };
  }, [orgId, load]);

  return { machines, error };
}

function TokenPlate({ name, token, onClose }) {
  return (
    <Plate title={`Link ${name}`} sub="The token is shown this once" warn onClose={onClose}
      actions={<><Copy text={LINK_CMD(token)} label="Copy the command" />
        <button className="primary" onClick={onClose}>Done</button></>}>
      <p>On {name}, in the rig repo's folder, run:</p>
      <pre className="log">{LINK_CMD(token)}</pre>
      <p className="help" style={{ marginTop: 12 }}>The app then reports its state here every 30 s. Anyone with
        this token can report as {name}: make a new one from its page if it leaks.</p>
    </Plate>
  );
}

function AddMachine({ org, onClose }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("rig");
  const [token, setToken] = useState(null);
  const act = useAction();
  if (token) return <TokenPlate name={token.name} token={token.token} onClose={onClose} />;
  return (
    <Plate title="Add a machine" onClose={onClose}
      actions={<><button onClick={onClose}>Cancel</button>
        <button className="primary" form="addm" disabled={act.busy}>Add it</button></>}>
      <form id="addm" className="params" onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => {
          const rows = await must(sb.rpc("create_machine", { p_org: org.id, p_name: name, p_kind: kind }));
          setToken({ name, token: rows[0].token });
        });
      }}>
        <label className="param">Name<input type="text" required pattern={NAME_RE} autoFocus placeholder="arms-01"
          title="Letters, digits, . _ - (up to 63)" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="param">What it is
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="rig">Rig PC: arms, cameras, the Quest</option>
            <option value="gpu">GPU PC: training and serving policies</option>
            <option value="other">Something else</option>
          </select></label>
        <Err error={act.error} />
      </form>
    </Plate>
  );
}

function MachineCard({ org, m, now }) {
  const s = machineState(m.last_seen_at, now);
  const lamps = lampsFor(m.status);
  const worst = worstLamp(lamps);
  return (
    <section className={`machine ${s}`}>
      <h2><a href={`#/org/${org.id}/machine/${m.id}`}>{m.name}</a><Pill state={s} />
        <span className="muted">{m.kind === "gpu" ? "GPU PC" : m.kind === "rig" ? "Rig PC" : "Other"}</span></h2>
      {s === "never" ? (
        <div className="empty"><b>Not linked yet</b><span>Run the link command on {m.name}; a new token is on its page.</span></div>
      ) : (
        <>
          {worst && s === "online" && <p className={`help ${worst.cls === "bad" ? "" : "warn"}`} style={worst.cls === "bad" ? { color: "var(--red-ink)" } : null}>
            {worst.word}: {worst.detail}</p>}
          <Lamps lamps={lamps.slice(0, 6)} />
        </>
      )}
      <div className="foot"><span className="tnum">{m.status?.commit ? String(m.status.commit).slice(0, 7) : m.version || ""}</span>
        <span>{s === "never" ? "never seen" : `seen ${ago(m.last_seen_at, now)}`}</span></div>
    </section>
  );
}

function Fleet({ org, isAdmin, onSummary }) {
  const now = useNow();
  const { machines, error } = useMachines(org.id);
  const [adding, setAdding] = useState(false);
  const sum = useMemo(() => machines && fleetSummary(machines, now), [machines, now]);
  useEffect(() => { onSummary(sum); }, [sum, onSummary]);

  if (error) return <main className="page"><section><Err error={error} /></section></main>;
  if (!machines) return <Loader page text="Asking the fleet…" />;
  return (
    <main className="page">
      <section>
        <div className="hero">
          <div>
            <div className="eyebrow">Fleet · {org.name}</div>
            <div className={`hero-word ${sum.cls}`}>{sum.word}</div>
            <p className="lede">{sum.sentence}</p>
          </div>
          {isAdmin && <div className="row"><button className="primary big" onClick={() => setAdding(true)}>Add a machine</button></div>}
        </div>
        {machines.length > 0 && (
          <div className="tiles" style={{ marginTop: 18 }}>
            <div className="tile"><div className="k">Online</div><div className={`v ${sum.n.online ? "ok" : ""}`}>{sum.n.online}</div></div>
            <div className="tile"><div className="k">Late</div><div className={`v ${sum.n.late ? "warn" : ""}`}>{sum.n.late}</div></div>
            <div className="tile"><div className="k">Offline</div><div className="v">{sum.n.offline + sum.n.never}</div></div>
            <div className="tile"><div className="k">Running a job</div><div className="v">{sum.n.jobs}</div></div>
          </div>
        )}
      </section>
      {machines.length > 0 && (
        <div className="cards">{machines.map((m) => <MachineCard key={m.id} org={org} m={m} now={now} />)}</div>
      )}
      {!machines.length && !isAdmin && (
        <section><div className="empty"><b>No machines yet</b><span>An owner or admin of {org.name} adds them.</span></div></section>
      )}
      {adding && <AddMachine org={org} onClose={() => setAdding(false)} />}
    </main>
  );
}

function MachinePage({ org, machineId, isAdmin }) {
  const now = useNow(5000);
  const { machines, error } = useMachines(org.id);
  const [events, setEvents] = useState(null);
  const [token, setToken] = useState(null);
  const [rename, setRename] = useState("");
  const [ask, plate] = useConfirm();
  const act = useAction();
  const m = machines?.find((x) => x.id === machineId);

  useEffect(() => {
    let alive = true;
    const load = () => sb.from("machine_events").select("*").eq("machine_id", machineId)
      .order("id", { ascending: false }).limit(200)
      .then(({ data }) => alive && data && setEvents(data));
    load();
    const t = setInterval(load, 15000);
    const ch = sb.channel(`events:${machineId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "machine_events", filter: `machine_id=eq.${machineId}` },
        (p) => setEvents((ev) => [p.new, ...(ev || []).filter((e) => e.id !== p.new.id)].slice(0, 200)))
      .subscribe();
    return () => { alive = false; clearInterval(t); sb.removeChannel(ch); };
  }, [machineId]);

  if (error) return <main className="page"><section><Err error={error} /></section></main>;
  if (!machines) return <Loader page text="Asking the machine…" />;
  if (!m) return (
    <main className="page"><section><div className="empty"><b>That machine is gone</b>
      <span><a href={`#/org/${org.id}`}>Back to the fleet</a></span></div></section></main>
  );

  const s = machineState(m.last_seen_at, now);
  const lamps = lampsFor(m.status);
  const worst = s === "online" ? worstLamp(lamps) : null;
  const sentence = s === "never" ? "Not linked yet: run the link command on it."
    : worst ? `${worst.word}: ${worst.detail}` : s === "online" ? (m.status?.job ? `Running ${m.status.job}` : "Idle")
    : `Last seen ${ago(m.last_seen_at, now)}`;
  const st = m.status || {};

  return (
    <main className="page">
      <section>
        <div className="hero">
          <div>
            <div className="eyebrow"><a href={`#/org/${org.id}`}>Fleet</a> · {m.name}</div>
            <div className={`hero-word ${worst?.cls === "bad" ? "bad" : s === "late" || worst ? "warn" : ""}`}>
              {s === "online" ? (st.job ? String(st.job)[0].toUpperCase() + String(st.job).slice(1) : "Idle") : STATE[s].word}</div>
            <p className="lede">{sentence}</p>
          </div>
          <div className="row"><Pill state={s} /></div>
        </div>
      </section>
      <div className="deck">
        <div className="work">
          <section>
            <h2>Status <span className="muted">as {m.name}'s app last reported it</span></h2>
            {lamps.length ? <Lamps lamps={lamps} /> : <div className="empty"><b>Nothing reported yet</b></div>}
          </section>
          <section>
            <h2>Events <span className="muted">newest first</span></h2>
            {!events ? <Loader text="Loading the events…" /> : events.length === 0 ? (
              <div className="empty"><b>None yet</b><span>Jobs starting and ending, faults and updates land here.</span></div>
            ) : (
              <div className="events">
                {events.map((e) => (
                  <div className="ev" key={e.id}>
                    <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>{ago(e.at, now)}</time>
                    <span className={`pill ${e.kind === "fault" ? "bad" : e.kind === "warn" ? "warn" : ""}`}>{e.kind}</span>
                    <span className="msg">{e.message}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
        <div className="ctx">
          <section>
            <h2>This machine</h2>
            <div className="lamps">
              {[["Kind", m.kind === "gpu" ? "GPU PC" : m.kind === "rig" ? "Rig PC" : "Other"],
                ["Host", m.hostname || "—"], ["Branch", st.branch || "—"],
                ["Code", st.commit ? String(st.commit).slice(0, 10) : m.version || "—"],
                ["Update", st.update || "—"], ["Seen", ago(m.last_seen_at, now)],
                ["Added", new Date(m.created_at).toLocaleDateString()]].map(([k, v]) => (
                <span className="lamp fact" key={k}><b>{k}</b>
                  <span className={`lv ${["Code", "Branch"].includes(k) ? "tnum" : ""}`}>{v}</span></span>
              ))}
            </div>
          </section>
          {isAdmin && (
            <section>
              <h2>Manage</h2>
              <div className="action">
                <form className="row" onSubmit={(e) => {
                  e.preventDefault();
                  act.run(async () => { await must(sb.from("machines").update({ name: rename }).eq("id", m.id)); setRename(""); });
                }}>
                  <input type="text" className="grow" placeholder={`Rename ${m.name}`} required pattern={NAME_RE}
                    value={rename} onChange={(e) => setRename(e.target.value)} aria-label="New name" />
                  <button disabled={act.busy}>Rename</button>
                </form>
              </div>
              <div className="action">
                <b>A new token</b>
                <p className="help">The old one stops at once; link {m.name} again with the new one.</p>
                <div className="row" style={{ marginTop: 10 }}>
                  <button disabled={act.busy} onClick={async () => {
                    if (!(await ask({ title: `A new token for ${m.name}?`, text: "Its old token stops working at once: the machine reports nothing until it is linked again.", yes: "Make a new token", danger: true }))) return;
                    act.run(async () => setToken(await must(sb.rpc("rotate_machine_token", { p_machine: m.id }))));
                  }}>New token</button>
                </div>
              </div>
              <div className="action">
                <b>Remove it</b>
                <p className="help">Its events go with it; its files stay.</p>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="danger" disabled={act.busy} onClick={async () => {
                    if (!(await ask({ title: `Remove ${m.name}?`, text: `${m.name} and its events leave ${org.name}. Its files stay. It cannot report again until it is added and linked anew.`, yes: "Remove it", danger: true }))) return;
                    act.run(async () => { await must(sb.from("machines").delete().eq("id", m.id)); location.hash = `#/org/${org.id}`; });
                  }}>Remove {m.name}</button>
                </div>
              </div>
              <Err error={act.error} />
            </section>
          )}
        </div>
      </div>
      {token && <TokenPlate name={m.name} token={token} onClose={() => setToken(null)} />}
      {plate}
    </main>
  );
}

// ── members ─────────────────────────────────────────────────────────────────────────────

function Members({ org, role, me, reloadOrgs }) {
  const [members, setMembers] = useState(null);
  const [invites, setInvites] = useState([]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [ask, plate] = useConfirm();
  const act = useAction();
  const isAdmin = role === "owner" || role === "admin";
  const { run } = act;

  const load = useCallback(() => run(async () => {
    const ms = await must(sb.from("org_members").select("user_id, role, created_at").eq("org_id", org.id));
    const ps = ms.length ? await must(sb.from("profiles").select("id, email, display_name").in("id", ms.map((x) => x.user_id))) : [];
    const byId = Object.fromEntries(ps.map((p) => [p.id, p]));
    const order = { owner: 0, admin: 1, member: 2 };
    setMembers(ms.map((x) => ({ ...x, profile: byId[x.user_id] || {} }))
      .sort((a, b) => order[a.role] - order[b.role] || (a.profile.email || "").localeCompare(b.profile.email || "")));
    if (isAdmin) setInvites(await must(sb.from("org_invites").select("*").eq("org_id", org.id).order("created_at")));
  }), [org.id, isAdmin, run]);
  useEffect(() => { load(); }, [load]);

  const remove = async (m) => {
    const self = m.user_id === me;
    const ok = await ask(self
      ? { title: `Leave ${org.name}?`, text: "You stop seeing its fleet and files until someone invites you again.", yes: "Leave", danger: true }
      : { title: `Remove ${m.profile.email}?`, text: `They stop seeing ${org.name}'s fleet and files.`, yes: "Remove", danger: true });
    if (!ok) return;
    run(async () => {
      await must(sb.rpc("remove_member", { p_org: org.id, p_user: m.user_id }));
      if (self) { await reloadOrgs(); location.hash = "#/"; } else load();
    });
  };

  return (
    <main className="page">
      <div className="deck">
        <div className="work">
          <section>
            <h2>People <span className="muted">{members ? `${members.length} in ${org.name}` : ""}</span></h2>
            {!members ? <Loader text="Loading the people…" /> : (
              <div className="rows">
                {members.map((m) => (
                  <div className="rowline" key={m.user_id}>
                    <span className="who"><b>{m.profile.display_name || m.profile.email}{m.user_id === me ? " (you)" : ""}</b>
                      <span className="muted">{m.profile.display_name ? `${m.profile.email} · ` : ""}since {new Date(m.created_at).toLocaleDateString()}</span></span>
                    <span className="acts">
                      {role === "owner" ? (
                        <select value={m.role} aria-label={`Role of ${m.profile.email}`} disabled={act.busy}
                          onChange={(e) => run(async () => {
                            await must(sb.rpc("set_member_role", { p_org: org.id, p_user: m.user_id, p_role: e.target.value }));
                            await load();
                            await reloadOrgs();
                          })}>
                          <option value="owner">Owner</option><option value="admin">Admin</option><option value="member">Member</option>
                        </select>
                      ) : <span className="pill">{m.role}</span>}
                      {(m.user_id === me || role === "owner" || (role === "admin" && m.role === "member")) && (
                        <button className="small" disabled={act.busy} onClick={() => remove(m)}>
                          {m.user_id === me ? "Leave" : "Remove"}</button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Err error={act.error} />
          </section>
          {isAdmin && invites.length > 0 && (
            <section>
              <h2>Invited <span className="muted">waiting for them to sign in</span></h2>
              <div className="rows">
                {invites.map((i) => (
                  <div className="rowline" key={i.id}>
                    <span className="who"><b>{i.email}</b><span className="muted">as {i.role} · {ago(i.created_at)}</span></span>
                    <button className="small" disabled={act.busy} onClick={() => run(async () => {
                      await must(sb.from("org_invites").delete().eq("id", i.id));
                      await load();
                    })}>Take back</button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="ctx">
          {isAdmin ? (
            <section>
              <h2>Invite someone</h2>
              <p className="help">They make an account (or sign in) with that email at app.exp.bot; the invite waits for them there.</p>
              <form className="params" onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await must(sb.rpc("invite_member", { p_org: org.id, p_email: email, p_role: inviteRole }));
                  setEmail("");
                  await load();
                });
              }}>
                <label className="param">Email<input type="email" placeholder="name@example.com" required value={email}
                  onChange={(e) => setEmail(e.target.value)} /></label>
                <label className="param">As
                  <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                    <option value="member">Member: sees the fleet and files</option>
                    {role === "owner" && <option value="admin">Admin: also adds machines and people</option>}
                  </select></label>
                <div className="row"><button className="primary" disabled={act.busy}>Invite</button></div>
              </form>
            </section>
          ) : (
            <section><div className="empty"><b>You are a member</b><span>An owner or admin invites people and adds machines.</span></div></section>
          )}
          {role === "owner" && <OrgSettings org={org} reloadOrgs={reloadOrgs} ask={ask} />}
        </div>
      </div>
      {plate}
    </main>
  );
}

function OrgSettings({ org, reloadOrgs, ask }) {
  const [name, setName] = useState(org.name);
  const act = useAction();
  useEffect(() => setName(org.name), [org.name]);
  return (
    <section>
      <h2>The org</h2>
      <div className="action">
        <form className="row" onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => { await must(sb.from("orgs").update({ name }).eq("id", org.id)); await reloadOrgs(); });
        }}>
          <input type="text" className="grow" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-label="Org name" />
          <button disabled={act.busy || name === org.name}>Rename</button>
        </form>
      </div>
      <div className="action">
        <b>Delete {org.name}</b>
        <p className="help">For everyone: its machines, their events and its people. Its files are kept until removed by hand.</p>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="danger" disabled={act.busy} onClick={async () => {
            if (!(await ask({ title: `Delete ${org.name}?`, text: `${org.name}, its machines and their events go for everyone. This cannot be undone.`, yes: "Delete the org", danger: true }))) return;
            act.run(async () => { await must(sb.from("orgs").delete().eq("id", org.id)); await reloadOrgs(); location.hash = "#/"; });
          }}>Delete the org</button>
        </div>
      </div>
      <Err error={act.error} />
    </section>
  );
}

// ── files ───────────────────────────────────────────────────────────────────────────────

function Files({ org, isAdmin }) {
  const [dir, setDir] = useState("");
  const [items, setItems] = useState(null);
  const [tops, setTops] = useState([]);
  const [ask, plate] = useConfirm();
  const act = useAction();
  const { run } = act;
  const base = dir ? `${org.id}/${dir}` : org.id;

  const list = (path) => must(sb.storage.from(BUCKET).list(path, { limit: 1000, sortBy: { column: "name", order: "asc" } }));
  const load = useCallback(() => run(async () => setItems(await list(base))), [base, run]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { list(org.id).then((xs) => setTops(xs.filter((x) => x.id === null))).catch(() => {}); }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const crumbs = dir ? dir.split("/") : [];
  const top = crumbs[0] || "";
  const shown = (items || []).filter((f) => f.name !== ".emptyFolderPlaceholder");
  const open = async (name) => {
    const data = await must(sb.storage.from(BUCKET).createSignedUrl(`${base}/${name}`, 300, { download: name }));
    location.href = data.signedUrl;
  };

  return (
    <main className="page">
      <div className="deck deck-lib">
        <div className="nav">
          <div className="nav-label">Machines' folders</div>
          <div className="navlist">
            <button className={!dir ? "on" : ""} onClick={() => setDir("")}>All files</button>
            {tops.map((t) => <button key={t.name} className={top === t.name ? "on" : ""} onClick={() => setDir(t.name)}>{t.name}</button>)}
          </div>
          <p className="help">Each machine uploads under its own name: logs, calibration pictures, runs.</p>
        </div>
        <div className="work">
          <section>
            <h2>{dir ? crumbs[crumbs.length - 1] : "All files"} <span className="muted">{items ? `${shown.length} item${shown.length === 1 ? "" : "s"}` : ""}</span></h2>
            <div className="crumbs">
              <button className="link" onClick={() => setDir("")}>{org.name}</button>
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>/<button className="link" onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}>{c}</button></React.Fragment>
              ))}
            </div>
            {!items ? <Loader text="Listing…" /> : shown.length === 0 ? (
              <div className="empty"><b>Nothing here yet</b><span>Machines upload here; you can too, below.</span></div>
            ) : (
              <div className="rows">
                {shown.map((f) => f.id === null ? (
                  <div className="rowline" key={f.name}>
                    <span className="who"><button className="link" style={{ textAlign: "left" }} onClick={() => setDir(dir ? `${dir}/${f.name}` : f.name)}>{f.name}/</button></span>
                    <span className="muted">folder</span>
                  </div>
                ) : (
                  <div className="rowline" key={f.name}>
                    <span className="who"><button className="link" style={{ textAlign: "left" }} onClick={() => run(() => open(f.name))}>{f.name}</button></span>
                    <span className="acts"><span className="muted tnum">{bytes(f.metadata?.size)}</span>
                      <span className="muted">{ago(f.updated_at || f.created_at)}</span>
                      {isAdmin && <button className="small" disabled={act.busy} onClick={async () => {
                        if (!(await ask({ title: `Delete ${f.name}?`, text: "For everyone in the org. This cannot be undone.", yes: "Delete", danger: true }))) return;
                        run(async () => { await must(sb.storage.from(BUCKET).remove([`${base}/${f.name}`])); await load(); });
                      }}>Delete</button>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="action" style={{ marginTop: 14, borderTop: "1px solid var(--rule-soft)", paddingTop: 14 }}>
              <label className="param">Upload into {dir || org.name}
                <input type="file" multiple disabled={act.busy} onChange={(e) => {
                  const files = [...e.target.files];
                  e.target.value = "";
                  run(async () => {
                    for (const f of files) await must(sb.storage.from(BUCKET).upload(`${base}/${f.name}`, f, { upsert: true }));
                    await load();
                  });
                }} /></label>
              {act.busy && <Loader text="Working…" />}
            </div>
            <Err error={act.error} />
          </section>
        </div>
      </div>
      {plate}
    </main>
  );
}

// ── the app ─────────────────────────────────────────────────────────────────────────────

function OrgPage({ route, orgs, me, reloadOrgs, onSummary }) {
  const org = orgs.find((o) => o.id === route.org);
  useEffect(() => { if (!org || route.page !== "org" || route.tab !== "fleet") onSummary(null); }, [org, route, onSummary]);
  if (!org) return (
    <main className="page"><section><div className="empty"><b>No such org, or you are not in it</b>
      <span><a href="#/">Your orgs</a></span></div></section></main>
  );
  const isAdmin = org.role === "owner" || org.role === "admin";
  if (route.page === "machine") return <MachinePage org={org} machineId={route.machine} isAdmin={isAdmin} />;
  if (route.tab === "members") return <Members org={org} role={org.role} me={me} reloadOrgs={reloadOrgs} />;
  if (route.tab === "files") return <Files org={org} isAdmin={isAdmin} />;
  return <Fleet org={org} isAdmin={isAdmin} onSummary={onSummary} />;
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [recovering, setRecovering] = useState(false);
  const [orgs, setOrgs] = useState(null);
  const [summary, setSummary] = useState(null);
  const route = useRoute();

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      setSession(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const me = session?.user?.id;
  const reloadOrgs = useCallback(async () => {
    if (!me) return;
    const rows = await must(sb.from("org_members").select("role, orgs(id, name)").eq("user_id", me));
    setOrgs(rows.filter((r) => r.orgs).map((r) => ({ ...r.orgs, role: r.role })).sort((a, b) => a.name.localeCompare(b.name)));
  }, [me]);
  useEffect(() => { reloadOrgs().catch(() => setOrgs([])); }, [reloadOrgs]);
  useEffect(() => { if (route.page === "home") setSummary(null); }, [route.page]);

  if (session === undefined) return <main className="gate"><Loader /></main>;
  if (recovering && session) return <SetPassword onDone={() => setRecovering(false)} />;
  if (!session) return <SignIn />;

  return (
    <>
      <Rail route={route} orgs={orgs} email={session.user.email} summary={summary} />
      <div className="content">
        {orgs === null ? <Loader page text="Loading your orgs…" />
          : route.page === "home" ? <Home orgs={orgs} reloadOrgs={reloadOrgs} />
          : <OrgPage route={route} orgs={orgs} me={me} reloadOrgs={reloadOrgs} onSummary={setSummary} />}
      </div>
    </>
  );
}
