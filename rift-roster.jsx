import { useState, useEffect, useMemo } from "react";

const curve = (l) => (l - 1) * (0.7025 + 0.0175 * (l - 1));

const STATS = [
  { k: "hp",  label: "Health",        short: "HP",  dp: 0, f: (s, m) => s.hp + s.hpperlevel * m },
  { k: "hp5", label: "Health regen",  short: "HP5", dp: 2, f: (s, m) => s.hpregen + s.hpregenperlevel * m },
  { k: "ad",  label: "Attack damage", short: "AD",  dp: 1, f: (s, m) => s.attackdamage + s.attackdamageperlevel * m },
  { k: "as",  label: "Attack speed",  short: "AS",  dp: 3, f: (s, m) => s.attackspeed * (1 + (s.attackspeedperlevel / 100) * m) },
  { k: "ar",  label: "Armor",         short: "AR",  dp: 1, f: (s, m) => s.armor + s.armorperlevel * m },
  { k: "mr",  label: "Magic resist",  short: "MR",  dp: 1, f: (s, m) => s.spellblock + s.spellblockperlevel * m },
  { k: "ms",  label: "Move speed",    short: "MS",  dp: 0, f: (s) => s.movespeed },
];
const EXTRA = [
  { k: "mp",    label: "Resource",     dp: 0, f: (s, m) => s.mp + s.mpperlevel * m },
  { k: "range", label: "Attack range", dp: 0, f: (s) => s.attackrange },
];
const ROLES = ["Fighter", "Tank", "Mage", "Assassin", "Marksman", "Support"];

const VOID = "#070a0f", PLATE = "#0e141c", RAISE = "#141c26";
const GOLD = "#c89b3c", LIT = "#e4c37b", TEAL = "#0ac8b9";
const INK = "#dfe6ee", MUTE = "#7e8a99", FAINT = "#54606e";
const DISP = "'Orbitron',ui-sans-serif,system-ui,sans-serif";
const BODY = "'Rajdhani',ui-sans-serif,system-ui,sans-serif";

const VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json";

export default function RiftRoster() {
  const [version, setVersion] = useState(null);
  const [champs, setChamps] = useState(null);
  // probe: which leg failed, so the sandbox test is conclusive rather than "something broke"
  const [probe, setProbe] = useState(null);
  const [fontsOk, setFontsOk] = useState(null);
  const [level, setLevel] = useState(18);
  const [sortKey, setSortKey] = useState("bst");
  const [query, setQuery] = useState("");
  const [roles, setRoles] = useState([]);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Rajdhani:wght@400;500;600&display=swap";
    link.onload = () => setFontsOk(true);
    link.onerror = () => setFontsOk(false);
    document.head.appendChild(link);
    return () => { try { document.head.removeChild(link); } catch {} };
  }, []);

  useEffect(() => {
    let dead = false;
    (async () => {
      let stage = "versions";
      try {
        const vres = await fetch(VERSIONS_URL);
        if (!vres.ok) throw new Error(`HTTP ${vres.status}`);
        const vs = await vres.json();
        const v = vs[0];

        stage = "champions";
        const cres = await fetch(
          `https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`
        );
        if (!cres.ok) throw new Error(`HTTP ${cres.status}`);
        const j = await cres.json();
        const list = Object.values(j.data);
        if (!list.length) throw new Error("empty champion payload");

        if (dead) return;
        setVersion(v);
        setChamps(list);
        setProbe({ ok: true, count: list.length, version: v });
      } catch (e) {
        if (!dead) setProbe({ ok: false, stage, message: String(e && e.message ? e.message : e) });
      }
    })();
    return () => { dead = true; };
  }, []);

  const adBroken = useMemo(
    () => !!champs && champs.every((c) => !c.stats.attackdamageperlevel),
    [champs]
  );

  const scored = useMemo(() => {
    if (!champs) return [];
    const m = curve(level);
    const rows = champs.map((c) => {
      const v = {};
      for (const s of [...STATS, ...EXTRA]) v[s.k] = s.f(c.stats, m);
      return { id: c.id, name: c.name, tags: c.tags || [], v };
    });
    const b = {};
    for (const s of STATS) {
      const a = rows.map((r) => r.v[s.k]);
      b[s.k] = [Math.min(...a), Math.max(...a)];
    }
    for (const r of rows) {
      r.norm = {}; let sum = 0;
      for (const s of STATS) {
        const [lo, hi] = b[s.k];
        const n = hi === lo ? 50 : ((r.v[s.k] - lo) / (hi - lo)) * 100;
        r.norm[s.k] = n; sum += n;
      }
      r.bst = sum / STATS.length;
    }
    return rows;
  }, [champs, level]);

  const rows = useMemo(() => {
    const t = query.trim().toLowerCase();
    return scored
      .filter((r) => !t || r.name.toLowerCase().includes(t))
      .filter((r) => !roles.length || roles.some((x) => r.tags.includes(x)))
      .sort((a, b) => (sortKey === "bst" ? b.bst - a.bst : b.v[sortKey] - a.v[sortKey]));
  }, [scored, query, roles, sortKey]);

  const def = STATS.find((s) => s.k === sortKey);
  const top = rows.length ? (sortKey === "bst" ? rows[0].bst : rows[0].v[sortKey]) : 1;

  const chip = (on, accent) => ({
    font: `600 11px ${BODY}`, letterSpacing: ".11em", textTransform: "uppercase",
    padding: "5px 11px", borderRadius: 2, cursor: "pointer",
    border: `1px solid ${on ? (accent === TEAL ? "rgba(10,200,185,.5)" : "rgba(200,155,60,.55)") : "rgba(255,255,255,.05)"}`,
    color: on ? (accent === TEAL ? TEAL : LIT) : MUTE,
    background: on ? (accent === TEAL ? "rgba(10,200,185,.08)" : "rgba(200,155,60,.09)") : "transparent",
  });
  const kicker = {
    fontFamily: DISP, fontSize: 9, letterSpacing: ".22em",
    textTransform: "uppercase", color: FAINT,
  };

  return (
    <div style={{ position: "relative", minHeight: "100vh", background: VOID, color: INK, fontFamily: BODY }}>
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 3,
        background: "repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.06) 2px,rgba(0,0,0,.06) 4px)" }} />
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 3,
        background: "radial-gradient(ellipse at center,transparent 35%,rgba(0,0,0,.7) 100%)" }} />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 900, margin: "0 auto", padding: "26px 14px 70px" }}>
        <div style={{ fontFamily: DISP, fontSize: 9, letterSpacing: ".34em", color: TEAL, textTransform: "uppercase" }}>
          Summoner's Rift · base statistics
        </div>
        <h1 style={{ fontFamily: DISP, fontWeight: 700, fontSize: 23, letterSpacing: ".11em",
                     margin: "6px 0 0", color: LIT, textTransform: "uppercase" }}>Rift Roster</h1>
        <p style={{ fontSize: 13, color: MUTE, margin: "3px 0 0", letterSpacing: ".05em" }}>
          {version ? `Patch ${version} · ${champs.length} champions` : "Loading Data Dragon…"}
        </p>
        <div style={{ height: 1, margin: "14px 0 0", background: "linear-gradient(90deg,#c89b3c,rgba(200,155,60,0) 70%)" }} />

        {probe && !probe.ok && (
          <div style={{ marginTop: 22, borderLeft: `2px solid ${TEAL}`, paddingLeft: 12 }}>
            <p style={{ ...kicker, color: TEAL, margin: 0 }}>Network probe · blocked</p>
            <p style={{ fontSize: 15, lineHeight: 1.65, color: "#e39a9a", margin: "6px 0 0" }}>
              The <strong>{probe.stage === "versions" ? "versions.json" : "champion.json"}</strong> request
              failed: {probe.message}
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.7, color: MUTE, margin: "8px 0 0" }}>
              Outbound requests to Data Dragon are still refused inside the artifact sandbox, so a
              self-updating build isn't possible here. Use the baked-data artifact for this view and
              keep the GitHub Action as the thing that refreshes it on patch day.
            </p>
            {fontsOk === false && (
              <p style={{ fontSize: 13, lineHeight: 1.7, color: MUTE, margin: "8px 0 0" }}>
                Google Fonts was refused as well — the type below is the system fallback, not Orbitron.
              </p>
            )}
          </div>
        )}

        {probe && probe.ok && (
          <p style={{ ...kicker, color: TEAL, margin: "14px 0 0" }}>
            Network probe · Data Dragon reachable · {probe.count} champions on {probe.version}
          </p>
        )}

        {champs && (
          <>
            <div style={{ position: "sticky", top: 0, zIndex: 4, background: VOID,
                          padding: "14px 0 12px", borderBottom: "1px solid rgba(200,155,60,.18)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ ...kicker, color: MUTE, width: 46 }}>Level</span>
                <input type="range" min="1" max="18" step="1" value={level}
                       onChange={(e) => setLevel(+e.target.value)}
                       style={{ flex: 1, accentColor: GOLD, height: 22 }} aria-label="Champion level" />
                <span style={{ fontFamily: DISP, fontSize: 17, color: LIT, width: 30, textAlign: "right" }}>{level}</span>
              </div>

              <input value={query} onChange={(e) => { setQuery(e.target.value); setOpen(null); }}
                placeholder="Find a champion"
                style={{ width: "100%", marginTop: 10, background: PLATE, border: "1px solid rgba(255,255,255,.05)",
                         borderLeft: "2px solid rgba(200,155,60,.18)", color: INK, borderRadius: 2,
                         padding: "9px 11px", font: `500 15px ${BODY}` }} />

              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
                {ROLES.map((r) => (
                  <button key={r} style={chip(roles.includes(r), TEAL)}
                    onClick={() => { setOpen(null); setRoles((c) => c.includes(r) ? c.filter((x) => x !== r) : [...c, r]); }}>
                    {r}
                  </button>
                ))}
                {roles.length > 0 && (
                  <button onClick={() => { setRoles([]); setOpen(null); }}
                    style={{ border: "none", background: "none", color: FAINT, font: `600 11px ${BODY}`,
                             letterSpacing: ".11em", textTransform: "uppercase", cursor: "pointer" }}>reset</button>
                )}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
                {[{ k: "bst", short: "Total" }, ...STATS].map((s) => (
                  <button key={s.k} style={chip(sortKey === s.k, GOLD)}
                    onClick={() => { setSortKey(s.k); setOpen(null); }}>{s.short}</button>
                ))}
              </div>
            </div>

            {adBroken && (
              <p style={{ fontSize: 13, lineHeight: 1.65, color: "#a88a5f", margin: "14px 0 0",
                          borderLeft: "2px solid rgba(200,155,60,.4)", paddingLeft: 10 }}>
                Riot's current Data Dragon build reports attack-damage growth as 0 for every champion,
                so AD here holds at its level-1 value. Every other stat scales correctly.
              </p>
            )}

            <p style={{ ...kicker, margin: "16px 0 6px" }}>
              {rows.length} shown — {sortKey === "bst" ? "base stat total" : def.label} at level {level}
            </p>

            <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {rows.map((r, i) => {
                const cur = sortKey === "bst" ? r.bst : r.v[sortKey];
                const isOpen = open === r.id;
                return (
                  <li key={r.id} style={{ borderBottom: "1px solid rgba(255,255,255,.05)" }}>
                    <button onClick={() => setOpen(isOpen ? null : r.id)}
                      style={{ display: "flex", alignItems: "center", gap: 11, width: "100%",
                               padding: "9px 4px", background: "none", border: "none", color: "inherit",
                               textAlign: "left", cursor: "pointer", fontFamily: BODY }}>
                      <span style={{ fontFamily: DISP, fontSize: 10, color: FAINT, width: 26, textAlign: "right" }}>
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <img src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${r.id}.png`}
                        alt="" loading="lazy"
                        style={{ width: 36, height: 36, flex: "0 0 auto", background: RAISE,
                                 border: "1px solid rgba(255,255,255,.05)",
                                 clipPath: "polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px)" }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontWeight: 600, fontSize: 16, whiteSpace: "nowrap",
                                       overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                        <span style={{ display: "block", height: 2, background: "rgba(255,255,255,.06)", marginTop: 5 }}>
                          <span style={{ display: "block", height: "100%", width: `${Math.max(2, (cur / top) * 100)}%`,
                                         background: `linear-gradient(90deg,rgba(200,155,60,.45),${GOLD})` }} />
                        </span>
                      </span>
                      <span style={{ fontFamily: DISP, fontSize: 10, color: FAINT, width: 36, textAlign: "right" }}>
                        {r.bst.toFixed(1)}
                      </span>
                      <span style={{ fontFamily: DISP, fontSize: 15, color: LIT, width: 70, textAlign: "right" }}>
                        {sortKey === "bst" ? r.bst.toFixed(1) : cur.toFixed(def.dp)}
                      </span>
                    </button>

                    {isOpen && (
                      <div style={{ padding: "4px 4px 18px 74px", background: PLATE,
                                    borderLeft: "2px solid rgba(200,155,60,.35)" }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "10px 0 12px" }}>
                          {r.tags.map((t) => (
                            <span key={t} style={{ font: `600 10px ${BODY}`, letterSpacing: ".13em",
                              textTransform: "uppercase", padding: "3px 8px",
                              background: "rgba(200,155,60,.11)", color: LIT }}>{t}</span>
                          ))}
                          {EXTRA.map((s) => (
                            <span key={s.k} style={{ font: `600 10px ${BODY}`, letterSpacing: ".13em",
                              textTransform: "uppercase", padding: "3px 8px",
                              background: "rgba(255,255,255,.05)", color: MUTE }}>
                              {s.label} {r.v[s.k].toFixed(s.dp)}
                            </span>
                          ))}
                        </div>
                        {STATS.map((s) => (
                          <div key={s.k} style={{ display: "flex", alignItems: "center", gap: 9, margin: "6px 0" }}>
                            <span style={{ width: 104, font: `600 10px ${BODY}`, letterSpacing: ".13em",
                                           textTransform: "uppercase", color: MUTE }}>{s.label}</span>
                            <span style={{ width: 58, textAlign: "right", fontFamily: DISP, fontSize: 11 }}>
                              {r.v[s.k].toFixed(s.dp)}
                            </span>
                            <span style={{ flex: 1, height: 5, background: "rgba(255,255,255,.06)" }}>
                              <span style={{ display: "block", height: "100%", width: `${r.norm[s.k]}%`, background: GOLD }} />
                            </span>
                            <span style={{ width: 26, textAlign: "right", fontFamily: DISP, fontSize: 10, color: FAINT }}>
                              {Math.round(r.norm[s.k])}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>

            {rows.length === 0 && (
              <p style={{ ...kicker, marginTop: 20 }}>No match — reset the search or a role filter.</p>
            )}

            <footer style={{ color: FAINT, fontSize: 13, lineHeight: 1.75, marginTop: 28,
                             borderTop: "1px solid rgba(255,255,255,.05)", paddingTop: 16 }}>
              The dim number on each row is the base stat total: all seven stats min–max scaled 0–100
              across the roster at the current level, then averaged. It recomputes as the slider moves,
              so a champion with a high base and thin growth slides down as you climb. Resource and
              attack range show in the detail panel but stay out of the total. Level 18 is
              base + 17 × growth.
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
