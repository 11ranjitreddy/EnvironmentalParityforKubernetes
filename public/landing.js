const style = document.createElement("link");
style.rel = "stylesheet";
style.href = "landing.css";
document.head.append(style);
const fix = document.createElement("link");
fix.rel = "stylesheet";
fix.href = "landing-fix.css";
document.head.append(fix);
document.querySelector("#mysqlForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = e.currentTarget.querySelector("button"),
    o = document.querySelector("#mysqlResult");
  b.disabled = true;
  o.textContent = "Connecting…";
  o.className = "";
  try {
    const r = await fetch("/api/mysql-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: document.querySelector("#mysqlHost").value,
          port: document.querySelector("#mysqlPort").value,
          username: document.querySelector("#mysqlUser").value,
          password: document.querySelector("#mysqlPass").value,
        }),
      }),
      d = await r.json();
    if (!r.ok) throw Error(d.error);
    o.textContent = "✓ " + d.message;
    o.className = "success";
  } catch (x) {
    o.textContent = "✕ " + x.message;
    o.className = "failure";
  } finally {
    b.disabled = false;
  }
});
