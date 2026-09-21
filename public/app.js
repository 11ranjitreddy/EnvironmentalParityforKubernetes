const $ = (s) => document.querySelector(s);
let lastReport;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
["application", "baselineFile", "candidateFile"].forEach((id) =>
  $("#" + id).addEventListener("change", (e) => {
    const outputId = {
      application: "appName",
      baselineFile: "baseName",
      candidateFile: "candidateName",
    }[id];
    $("#" + outputId).textContent = e.target.files[0]?.name || "Choose file";
  }),
);
async function textFile(input, target) {
  const file = input.files[0];
  if (file) target.value = await file.text();
}
$("#baselineFile").addEventListener("change", (e) =>
  textFile(e.target, $("#baselineText")),
);
$("#candidateFile").addEventListener("change", (e) =>
  textFile(e.target, $("#candidateText")),
);
$("#uploadForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("#analyse");
  button.disabled = true;
  $("#status").textContent = "Analyzing configuration…";
  const form = new FormData();
  const app = $("#application").files[0];
  if (app) form.append("application", app);
  form.append("baselineText", $("#baselineText").value);
  form.append("candidateText", $("#candidateText").value);
  try {
    const r = await fetch("/api/analyse", { method: "POST", body: form });
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    lastReport = data;
    $("#editConfig").value = data.candidateText;
    render(data);
    $("#status").textContent = "Analysis saved locally.";
  } catch (error) {
    $("#status").textContent = "Error: " + error.message;
  } finally {
    button.disabled = false;
  }
});
function render(data) {
  $("#report").hidden = false;
  $("#report").scrollIntoView({ behavior: "smooth", block: "start" });
  const s = data.summary;
  $("#resultTitle").textContent = s.total
    ? `${s.total} configuration changes found`
    : "No configuration drift found";
  $("#resultSummary").textContent = data.application
    ? `Analyzed ${data.application.originalName} with ${data.candidateKeys} configuration entries.`
    : `Analyzed ${data.candidateKeys} configuration entries.`;
  $("#metrics").innerHTML = [
    ["Changed", s.changed],
    ["Added", s.added],
    ["Removed", s.removed],
    ["Critical", s.critical, "critical"],
    ["Validation issues", data.validations.length],
  ]
    .map(
      ([l, n, c]) =>
        `<div class="metric ${c || ""}"><b>${n}</b><span>${l}</span></div>`,
    )
    .join("");
  $("#changes").innerHTML = data.changes.length
    ? data.changes
        .map(
          (c) =>
            `<article class="change ${c.critical ? "critical" : ""}"><div class="change-top"><code class="key">${esc(c.key)}</code><span class="tag ${c.type}">${c.type.toUpperCase()}</span></div><div class="values">${c.type !== "added" ? `<span class="old">${esc(c.old)}</span>` : ""}${c.type === "changed" ? " &nbsp;→&nbsp; " : ""}${c.type !== "removed" ? esc(c.next) : ""}</div>${c.critical ? `<p class="note">⚠ ${esc(c.note)}</p>` : ""}</article>`,
        )
        .join("")
    : '<p class="empty">The proposed configuration matches the baseline.</p>';
  $("#validations").innerHTML = data.validations.length
    ? data.validations
        .map(
          (v) =>
            `<div class="validation ${v.level}"><b>${esc(v.key)}</b><br>${esc(v.message)}</div>`,
        )
        .join("")
    : '<div class="validation">✓ No basic validation issues detected.</div>';
}
$("#reanalyze").onclick = () => {
  $("#candidateText").value = $("#editConfig").value;
  $("#uploadForm").requestSubmit();
};
$("#download").onclick = () => {
  const blob = new Blob([$("#editConfig").value], { type: "text/plain" }),
    a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "deployment-config-reviewed.env";
  a.click();
  URL.revokeObjectURL(a.href);
};
$("#example").onclick = () => {
  $("#baselineText").value =
    "APP_ENV=production\nDATABASE_URL=postgres://prod-a\nAPI_TIMEOUT=3000\nPAYMENT_API_KEY=old-secret\nLOG_LEVEL=info\nREPLICAS=2";
  $("#candidateText").value =
    "APP_ENV=production\nDATABASE_URL=postgres://prod-b\nAPI_TIMEOUT=10000\nPAYMENT_API_KEY=new-secret\nLOG_LEVEL=debug\nREPLICAS=1\nSENTRY_DSN=https://logs.example";
  $("#uploadForm").requestSubmit();
};
