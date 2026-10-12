// Generates card-light.svg and card-dark.svg with the token owner's GitHub stats.
// Usage: GH_TOKEN=... node scripts/card.mjs   (MOCK=1 for fake local data)
import { writeFileSync } from "node:fs";

const DAY = 86400000;
const now = new Date();
const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const iso = (d) => d.toISOString();
const ymd = (d) => d.toISOString().slice(0, 10);

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${process.env.GH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function loadData() {
  const yearAgo = new Date(today - 364 * DAY);
  const twoYearsAgo = new Date(today - 729 * DAY);

  const a = await gql(
    `query($from: DateTime!, $to: DateTime!, $pFrom: DateTime!, $pTo: DateTime!) {
      viewer {
        login
        cal: contributionsCollection(from: $from, to: $to) {
          contributionCalendar { weeks { contributionDays { date contributionCount } } }
        }
        prev: contributionsCollection(from: $pFrom, to: $pTo) {
          contributionCalendar { totalContributions }
        }
      }
    }`,
    { from: iso(yearAgo), to: iso(now), pFrom: iso(twoYearsAgo), pTo: iso(yearAgo) }
  );

  const days = a.viewer.cal.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: new Date(d.date + "T00:00:00Z"), count: d.contributionCount }))
    .filter((d) => d.date <= today);

  // Start from the first day that begins steady activity (3+ active days within 30 days),
  // so a stray old commit doesn't stretch the chart. Go rolling only when that is a year back.
  const hasHistory = a.viewer.prev.contributionCalendar.totalContributions > 0;
  const activeDays = days.filter((d) => d.count > 0);
  const first =
    activeDays.find((d) => activeDays.filter((x) => x.date >= d.date && x.date - d.date < 30 * DAY).length >= 3) ||
    activeDays[0];
  const rolling = !first || (hasHistory && first.date - yearAgo < 30 * DAY);
  const start = rolling ? yearAgo : first.date;

  const b = await gql(
    `query($from: DateTime!, $to: DateTime!, $q: String!) {
      viewer {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalRepositoriesWithContributedCommits
          commitContributionsByRepository(maxRepositories: 100) {
            contributions { totalCount }
            repository { languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } } }
          }
        }
      }
      search(query: $q, type: ISSUE) { issueCount }
    }`,
    {
      from: iso(start),
      to: iso(now),
      q: `author:${a.viewer.login} is:pr is:merged merged:>=${ymd(start)}`,
    }
  );

  const cc = b.viewer.contributionsCollection;

  // Languages weighted by commit count in each repo.
  const langs = {};
  const colors = {};
  for (const r of cc.commitContributionsByRepository) {
    const edges = r.repository.languages.edges;
    const total = edges.reduce((s, e) => s + e.size, 0);
    if (!total) continue;
    for (const e of edges) colors[e.node.name] = e.node.color;
    for (const e of edges) langs[e.node.name] = (langs[e.node.name] || 0) + (e.size / total) * r.contributions.totalCount;
  }

  return {
    rolling,
    start,
    days: days.filter((d) => d.date >= start),
    commits: cc.totalCommitContributions,
    repos: cc.totalRepositoriesWithContributedCommits,
    prs: b.search.issueCount,
    langs,
    colors,
  };
}

function mockData() {
  const start = new Date(today - 14 * DAY);
  const days = [];
  for (let t = start.getTime(); t <= today.getTime(); t += DAY) {
    days.push({ date: new Date(t), count: [0, 6, 17, 22, 1, 0, 0, 5, 3, 3, 0, 2, 0, 4, 1][days.length] ?? 0 });
  }
  return { rolling: false, start, days, commits: 49, repos: 4, prs: 0, langs: { TypeScript: 30, Python: 12, Shell: 4, Swift: 2 }, colors: { TypeScript: "#3178c6", Python: "#3572A5", Shell: "#89e051", Swift: "#F05138" } };
}

// ---------- rendering ----------

const THEMES = {
  light: { bg: "#ffffff", border: "#d1d9e0", text: "#1f2328", sub: "#59636e", muted: "#818b98", bar: "#c8d1da", hot: "#1f2328", other: "#c8d1da" },
  dark: { bg: "#0d1117", border: "#3d444d", text: "#f0f6fc", sub: "#9198a1", muted: "#6e7681", bar: "#3d444d", hot: "#f0f6fc", other: "#656c76" },
};
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => new Intl.NumberFormat("en-US").format(Math.round(n));
const monthYear = (d) => d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const shortDay = (d) => d.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });

function buckets(data) {
  const span = Math.round((today - data.start) / DAY) + 1;
  if (span <= 90) {
    // Daily, with at least 30 days on the axis.
    const axisStart = new Date(Math.min(data.start.getTime(), today.getTime() - 29 * DAY));
    const map = new Map(data.days.map((d) => [ymd(d.date), d.count]));
    const out = [];
    for (let t = axisStart.getTime(); t <= today.getTime(); t += DAY) out.push(map.get(ymd(new Date(t))) || 0);
    return { values: out, from: axisStart, hot: 7 };
  }
  const weeks = Math.ceil(span / 7);
  const out = new Array(weeks).fill(0);
  for (const d of data.days) {
    const idx = weeks - 1 - Math.floor((today - d.date) / DAY / 7);
    if (idx >= 0) out[idx] += d.count;
  }
  return { values: out, from: data.start, hot: 4 };
}

function render(data, theme) {
  const t = THEMES[theme];
  const W = 480, PAD = 20, inner = W - PAD * 2;

  const total = data.days.reduce((s, d) => s + d.count, 0);
  const active = data.days.filter((d) => d.count > 0).length;
  const plural = (n, one, many) => (n === 1 ? one : many);
  const metrics = [
    [total, plural(total, "contribution", "contributions")],
    [data.commits, plural(data.commits, "commit", "commits")],
    [data.prs, plural(data.prs, "merged PR", "merged PRs")],
    [data.repos, plural(data.repos, "repo", "repos")],
    [active, plural(active, "active day", "active days")],
  ].filter(([v]) => v > 0);

  const header = data.rolling ? "Last 12 months" : `Since ${monthYear(data.start)}`;
  const updated = `updated ${shortDay(today)}`;

  let y = PAD;
  let svg = "";

  // Header
  y += 13;
  svg += `<text x="${PAD}" y="${y}" font-family="${SANS}" font-size="13" fill="${t.sub}">${esc(header)}</text>`;
  svg += `<text x="${W - PAD}" y="${y}" text-anchor="end" font-family="${SANS}" font-size="11" fill="${t.muted}">${esc(updated)}</text>`;

  // Metrics
  y += 34;
  const colW = inner / Math.max(metrics.length, 4);
  metrics.forEach(([v, label], i) => {
    const x = PAD + i * colW;
    svg += `<text x="${x}" y="${y}" font-family="${MONO}" font-size="22" font-weight="500" fill="${t.text}">${fmt(v)}</text>`;
    svg += `<text x="${x}" y="${y + 17}" font-family="${SANS}" font-size="11" fill="${t.sub}">${esc(label)}</text>`;
  });

  // Activity bars
  y += 40;
  const { values, from, hot } = buckets(data);
  const H = 36, gap = 2;
  const bw = (inner - gap * (values.length - 1)) / values.length;
  const max = Math.max(...values, 1);
  values.forEach((v, i) => {
    const h = v > 0 ? Math.max(3, (v / max) * H) : 1.5;
    const x = PAD + i * (bw + gap);
    const fill = i >= values.length - hot ? t.hot : t.bar;
    svg += `<rect x="${x.toFixed(2)}" y="${(y + H - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="1" fill="${fill}"/>`;
  });
  y += H + 15;
  svg += `<text x="${PAD}" y="${y}" font-family="${SANS}" font-size="11" fill="${t.muted}">${esc(shortDay(from))}</text>`;
  svg += `<text x="${W - PAD}" y="${y}" text-anchor="end" font-family="${SANS}" font-size="11" fill="${t.muted}">today</text>`;

  // Languages
  const entries = Object.entries(data.langs).sort((a, b) => b[1] - a[1]);
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  if (sum > 0) {
    let top = entries.slice(0, 4).map(([n, v]) => [n, v / sum, data.colors[n] || t.other]);
    const rest = 1 - top.reduce((s, [, p]) => s + p, 0);
    if (rest >= 0.01) top.push(["Other", rest, t.other]);
    top = top.filter(([, p]) => p >= 0.01);

    y += 18;
    let x = PAD;
    const segGap = 2, avail = inner - segGap * (top.length - 1);
    top.forEach(([, p, c]) => {
      const w = avail * p;
      svg += `<rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="6" rx="1" fill="${c}"/>`;
      x += w + segGap;
    });
    y += 22;
    let lx = PAD;
    top.forEach(([n, p, c]) => {
      const label = `${n} ${Math.round(p * 100)}%`;
      const itemW = 13 + label.length * 6.9;
      if (lx > PAD && lx + itemW > W - PAD) {
        lx = PAD;
        y += 18;
      }
      svg += `<circle cx="${lx + 4}" cy="${y - 4}" r="4" fill="${c}"/>`;
      svg += `<text x="${lx + 13}" y="${y}" font-family="${SANS}" font-size="11" fill="${t.sub}">${esc(label)}</text>`;
      lx += itemW + 14;
    });
  }

  const Hsvg = y + PAD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hsvg}" viewBox="0 0 ${W} ${Hsvg}" role="img" aria-label="GitHub stats">
<rect x="0.5" y="0.5" width="${W - 1}" height="${Hsvg - 1}" rx="8" fill="${t.bg}" stroke="${t.border}"/>
${svg}
</svg>
`;
}

const data = process.env.MOCK ? mockData() : await loadData();
writeFileSync("card-light.svg", render(data, "light"));
writeFileSync("card-dark.svg", render(data, "dark"));
console.log("card-light.svg and card-dark.svg updated");
