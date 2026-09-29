(() => {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const state = vscode.getState() ?? { collapsed: {} };
  const hues = [210, 150, 30, 285, 0, 180, 60, 330];

  window.addEventListener("message", (event) => {
    if (event.data.type === "data") render(event.data);
  });

  function render({ groups, error, running, update }) {
    root.replaceChildren(renderHeader(running, update));
    if (error) {
      root.append(el("p", "message error", error));
      return;
    }
    if (groups.length === 0) {
      root.append(el("p", "message", "Aucun worktree. Dans une conversation : /worktree <branche>."));
      return;
    }
    for (const group of groups) root.append(renderGroup(group));
  }

  function renderHeader(running, update) {
    const header = el("div", "hub-header");
    header.append(el("span", "version", `v${running.version}`), el("span", "built", formatDate(running.builtAt)));
    if (update) {
      const button = el("button", "update", `Mettre à jour : v${update.version} du ${formatDate(update.builtAt)}`);
      button.addEventListener("click", () => vscode.postMessage({ type: "update" }));
      header.append(button);
    }
    return header;
  }

  function formatDate(iso) {
    if (!iso) return "date de build inconnue";
    return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function renderGroup(group) {
    const section = el("section", "group");
    section.style.setProperty("--wt-accent-hue", String(hue(group.branch)));
    if (state.collapsed[group.path]) section.classList.add("collapsed");

    const header = el("header", "group-header");
    header.title = group.path;
    header.append(el("span", "chevron"), el("span", "name", group.name), el("span", "branch", group.branch), el("span", "count", String(group.sessions.length)));
    header.addEventListener("click", () => {
      state.collapsed[group.path] = !state.collapsed[group.path];
      vscode.setState(state);
      section.classList.toggle("collapsed");
    });

    const list = el("ul", "sessions");
    for (const session of group.sessions) list.append(renderSession(session, group));
    if (group.sessions.length === 0) list.append(el("li", "message", "Aucune conversation"));

    section.append(header, list);
    return section;
  }

  function renderSession(session, group) {
    const item = el("li", "session");
    item.tabIndex = 0;
    item.title = session.id;
    const meta = el("span", "meta");
    meta.append(el("span", "time", ago(session.modified)));
    if (session.branch && session.branch !== group.branch) meta.append(el("span", "branch", session.branch));
    item.append(el("span", "title", session.title), meta);
    const open = () => vscode.postMessage({ type: "open", id: session.id });
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
    return item;
  }

  function hue(text) {
    let hash = 0;
    for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hues[hash % hues.length];
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ago(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return "à l'instant";
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.round(hours / 24)} j`;
  }

  vscode.postMessage({ type: "ready" });
})();
