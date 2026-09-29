(() => {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const state = vscode.getState() ?? { collapsed: {} };
  const hues = [210, 150, 30, 285, 0, 180, 60, 330];
  const minLoadingMs = 500;
  const transitionLingerMs = 8000;
  let loadingSince = 0;
  const transitions = {};

  window.addEventListener("message", (event) => {
    if (event.data.type === "loading") setLoading(true);
    if (event.data.type === "data") {
      render(event.data);
      setTimeout(() => setLoading(false), Math.max(0, loadingSince + minLoadingMs - Date.now()));
    }
    if (event.data.type === "transition") showTransition(event.data);
  });

  function showTransition({ path, lines, status }) {
    transitions[path] = { lines, status };
    if (status !== "running") setTimeout(() => {
      if (transitions[path]?.lines === lines) {
        delete transitions[path];
        updateTransition(path);
      }
    }, transitionLingerMs);
    updateTransition(path);
    document.body.classList.toggle("busy", Object.values(transitions).some((transition) => transition.status === "running"));
  }

  function updateTransition(path) {
    const section = [...root.querySelectorAll(".group")].find((node) => node.dataset.path === path);
    if (!section) return;
    section.querySelector(".transition")?.remove();
    const transition = transitions[path];
    if (transition) section.querySelector(".group-header").after(renderTransition(transition));
  }

  function renderTransition({ lines, status }) {
    const box = el("div", `transition ${status}`);
    const list = el("ol", "steps");
    for (const line of lines) list.append(el("li", "step", line));
    box.append(list);
    if (status === "done") box.append(el("div", "result", "Terminé"));
    if (status === "error") box.append(el("div", "result", "Échec, rien n'a été perdu : voir la dernière ligne"));
    return box;
  }

  setInterval(() => {
    for (const node of document.querySelectorAll(".time")) node.textContent = ago(Number(node.dataset.ts));
  }, 30000);

  function setLoading(active) {
    if (active) loadingSince = Date.now();
    document.body.classList.toggle("loading", active);
    const status = root.querySelector(".status");
    if (status) status.textContent = active ? "Actualisation..." : status.dataset.idle;
  }

  function render({ groups, error, running, update, refreshedAt }) {
    root.replaceChildren(renderHeader(running, update, refreshedAt));
    if (error) {
      root.append(el("p", "message error", error));
      return;
    }
    for (const group of groups) root.append(renderGroup(group));
    if (!groups.some((group) => !group.main)) root.append(el("p", "message", "Aucun worktree. Dans une conversation : /worktree <branche>."));
  }

  function renderHeader(running, update, refreshedAt) {
    const header = el("div", "hub-header");
    const status = el("span", "status", `actualisé à ${formatTime(refreshedAt)}`);
    status.dataset.idle = status.textContent;
    const refresh = el("button", "refresh", "Actualiser");
    refresh.title = "Relire les worktrees et les conversations";
    refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    header.append(el("span", "version", `v${running.version}`), el("span", "built", `build ${formatDate(running.builtAt)}`), status, refresh);
    if (update) {
      const hot = update.contributes === running.contributes;
      const button = el("button", "update", `${hot ? "Charger à chaud" : "Mettre à jour (redémarrage)"} : v${update.version} du ${formatDate(update.builtAt)}`);
      button.title = hot ? "Recharge l'extension sans toucher aux conversations Claude Code" : "Cette version change les contributions : redémarrage des extensions, avec confirmation";
      button.addEventListener("click", () => vscode.postMessage({ type: "update" }));
      header.append(button);
    }
    return header;
  }

  function renderGroup(group) {
    const section = el("section", group.main ? `group main ${group.state}` : `group ${group.state}`);
    section.dataset.path = group.path;
    section.style.setProperty("--wt-accent-hue", String(hue(group.branch)));
    if (state.collapsed[group.path]) section.classList.add("collapsed");

    const header = el("header", "group-header");
    header.title = group.path;
    header.append(el("span", "chevron"), el("span", "name", group.name), el("span", "branch", group.branch));
    if (group.main) header.append(el("span", "tag", "current"));
    if (group.state === "taken") header.append(el("span", "tag state", "sur current"));
    if (group.state === "detached") header.append(el("span", "tag state", "détaché"));
    if (!group.main && group.state === "owned") header.append(action("Aller", "Committe le travail non committé du worktree sur " + group.branch + " (commit \"wip\"), puis git switch " + group.branch + " sur current ; le worktree reste sur les mêmes fichiers, détaché", "goto", group));
    if (!group.main && group.state === "taken") header.append(action("Revenir", "Committe les modifs de current sur " + group.branch + " (commit \"wip\"), current revient sur sa branche précédente, le worktree reprend " + group.branch + " et les commits \"wip\" sont défaits : le travail redevient non committé", "giveBack", group));
    section.append(header);
    if (transitions[group.path]) section.append(renderTransition(transitions[group.path]));
    if (group.main) return section;

    header.append(el("span", "count", String(group.sessions.length)));
    header.addEventListener("click", () => {
      state.collapsed[group.path] = !state.collapsed[group.path];
      vscode.setState(state);
      section.classList.toggle("collapsed");
    });

    const list = el("ul", "sessions");
    for (const session of group.sessions) list.append(renderSession(session, group));
    if (group.sessions.length === 0) list.append(el("li", "message", "Aucune conversation passée par /worktree"));

    section.append(list);
    return section;
  }

  function renderSession(session, group) {
    const item = el("li", "session");
    item.tabIndex = 0;
    item.title = session.id;
    const time = el("span", "time", ago(session.modified));
    time.dataset.ts = String(session.modified);
    const meta = el("span", "meta");
    meta.append(time);
    if (session.branch && session.branch !== group.branch) meta.append(el("span", "branch", session.branch));
    item.append(el("span", "title", session.title), meta);
    const open = () => vscode.postMessage({ type: "open", session });
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
    return item;
  }

  function action(label, title, type, group) {
    const button = el("button", "action", label);
    button.title = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type, target: { path: group.path, branch: group.branch } });
    });
    return button;
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

  function formatDate(iso) {
    if (!iso) return "inconnu";
    return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function ago(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return "à l'instant";
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.round(hours / 24)} j`;
  }

  setLoading(true);
  vscode.postMessage({ type: "ready" });
})();
