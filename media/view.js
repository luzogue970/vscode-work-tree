(() => {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const state = vscode.getState() ?? { collapsed: {} };
  const hues = [210, 150, 30, 285, 0, 180, 60, 330];
  const minLoadingMs = 500;
  const transitionLingerMs = 8000;
  let loadingSince = 0;
  const transitions = {};
  let defaultBranch = "main";

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

  function render({ groups, error, running, update, refreshedAt, defaultBranch: branch }) {
    defaultBranch = branch ?? defaultBranch;
    root.replaceChildren(renderHeader(running, update, refreshedAt));
    if (error) {
      root.append(el("p", "message error", error));
      return;
    }
    const late = groups.filter((group) => !group.main && !group.merged && group.behind > 0);
    if (late.length > 1) root.append(renderLate(late));
    const [current, ...others] = groups.filter((group) => group.current || !group.merged);
    if (current) root.append(renderGroup(current));
    if (others.length > 0) root.append(el("p", "section-label", "Autres worktrees"));
    for (const group of others) root.append(renderGroup(group));
    if (!groups.some((group) => !group.main)) root.append(el("p", "message", "Aucun worktree. Dans une conversation : /worktree <branche>."));
    const archived = groups.filter((group) => !group.current && group.merged);
    if (archived.length > 0) root.append(renderArchive(archived));
  }

  function renderLate(groups) {
    const box = el("div", "late-all");
    const button = el("button", "action", `Mettre à jour les ${groups.length} worktrees en retard sur ${defaultBranch}`);
    button.title = `Ouvre une conversation par worktree avec /worktree update <branche> pré-rempli : Entrée pour lancer le merge de ${defaultBranch}`;
    button.addEventListener("click", () => vscode.postMessage({ type: "mergeDefaultAll", targets: groups.map((group) => ({ path: group.path, branch: group.branch })) }));
    box.append(button);
    return box;
  }

  function renderArchive(groups) {
    const section = el("section", "archive");
    if (state.archiveCollapsed !== false) section.classList.add("collapsed");
    const header = el("header", "archive-header");
    header.append(el("span", "chevron"), el("span", "name", "Archivés"), el("span", "count", String(groups.length)));
    header.title = "Worktrees dont la branche est fusionnée ou qui n'existent plus, avec leurs conversations";
    header.addEventListener("click", () => {
      state.archiveCollapsed = !section.classList.toggle("collapsed") ? false : true;
      vscode.setState(state);
    });
    const list = el("div", "archived");
    for (const group of groups) list.append(renderGroup(group));
    section.append(header, list);
    return section;
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
    const section = el("section", `group ${group.state}${group.main ? " main" : ""}${group.current ? " current" : ""}${group.merged && !group.current ? " merged" : ""}`);
    section.dataset.path = group.path;
    section.style.setProperty("--wt-accent-hue", String(hue(group.branch)));
    if (state.collapsed[group.path]) section.classList.add("collapsed");

    const header = el("header", "group-header");
    header.title = group.path;
    const titleRow = el("div", "title-row");
    titleRow.append(el("span", "chevron"), el("span", "title", group.branch === "(détaché)" ? group.name : group.branch));
    if (!group.main) titleRow.append(el("span", "count", String(group.sessions.length)));
    const chips = el("div", "chips");
    const actions = el("div", "actions");
    header.append(titleRow, chips, actions);

    if (group.current) {
      const current = el("span", "tag current-tag", "current");
      current.title = group.main ? "Le dossier principal, sur aucune branche de worktree" : `On développe sur current, qui est sur ${group.branch}. Le worktree n'est qu'une sauvegarde : ce qui y arrive est rapatrié ici automatiquement, et il récupère le travail de current quand tu changes de branche.`;
      chips.append(current);
    }
    if (!group.main && group.name !== slug(group.branch)) {
      const folder = el("span", "tag folder", group.name);
      folder.title = `Dossier du worktree : ${group.path}`;
      chips.append(folder);
    }
    if (group.state === "detached") chips.append(el("span", "tag state", "détaché"));
    if (group.state === "removed") chips.append(el("span", "tag", "supprimé"));
    else if (group.merged) chips.append(el("span", "tag", "fusionnée"));
    if (!group.main && group.changes > 0) {
      const changes = el("span", "tag changes", `${group.changes} modif${group.changes > 1 ? "s" : ""}`);
      changes.title = group.state === "taken" ? "Fichiers modifiés ou nouveaux, non committés, sur current : ils iront dans ce worktree quand tu changeras de branche" : "Fichiers modifiés ou nouveaux, non committés, dans le worktree";
      chips.append(changes);
    }
    if (group.syncError) {
      const blocked = el("span", "tag blocked", "rapatriement bloqué");
      blocked.title = `Les modifs faites dans le worktree n'ont pas pu arriver sur current : ${group.syncError}`;
      chips.append(blocked);
    }
    const active = !group.main && !group.merged;
    if (active && group.behind > 0) {
      const late = el("span", "tag state late", `${group.behind} en retard sur ${defaultBranch}`);
      late.title = `${group.behind} commit(s) de ${defaultBranch} absents de ${group.branch}`;
      chips.append(late);
    }

    if (active && group.state === "owned") actions.append(action("Aller", `Échange : la branche de current retourne dans son worktree (ou son travail est garé), ${group.branch} arrive sur current avec le travail du worktree indexé, et sa conversation s'ouvre`, "goto", group));
    if (active && group.syncError) actions.append(action("Réessayer le rapatriement", "Amène les modifs faites dans le worktree sur current, indexées (staged), une fois le conflit réglé", "sync", group));
    if (active && group.state === "taken") actions.append(action(`Aller sur ${defaultBranch}`, `Synchronise ce qui reste du worktree, current passe sur ${defaultBranch}, le worktree reprend ${group.branch} avec tout le travail non committé (le sien et celui fait sur current)`, "gotoDefault", group));
    if (active && group.behind > 0) actions.append(action("Mettre à jour", `Ouvre une conversation avec /worktree update ${group.branch} pré-rempli : Entrée pour lancer le merge de ${defaultBranch}, résolution des conflits comprise`, "mergeDefault", group));
    if (active) actions.append(action("+ Conversation", "Nouvelle conversation Claude dans ce worktree : ouvre un onglet ici et lance /worktree " + group.branch, "newSession", group));
    if (chips.childElementCount === 0) chips.remove();
    if (actions.childElementCount === 0) actions.remove();

    section.append(header);
    if (transitions[group.path]) section.append(renderTransition(transitions[group.path]));
    if (group.main) return section;
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
    if (session.live) meta.append(el("span", "tag live", "en cours"));
    if (session.follow) {
      const away = el("span", "tag state", "hors de sa branche");
      away.title = `À l'ouverture, "${session.follow}" sera pré-rempli pour la ramener là où est ${group.branch}`;
      meta.append(away);
    }
    if (group.state === "owned") {
      const window = el("button", "icon", "↗");
      window.title = "Ouvrir cette conversation dans une nouvelle fenêtre VSCodium sur le worktree";
      window.addEventListener("click", (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: "openInWindow", session });
      });
      meta.append(window);
    }
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
      vscode.postMessage({ type, target: { path: group.path, branch: group.branch, session: group.sessions[0] } });
    });
    return button;
  }

  function slug(branch) {
    return branch.replaceAll("/", "-");
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
