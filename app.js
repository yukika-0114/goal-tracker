(() => {
  "use strict";

  const STORAGE_KEY = "goal-manager-goals-v1";

  // ---------- date helpers (all dates handled as local-midnight Date objects / 'YYYY-MM-DD' strings) ----------

  function isoToDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function dateToIso(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function todayDate() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function addMonths(date, n) {
    return new Date(date.getFullYear(), date.getMonth() + n, date.getDate());
  }

  function formatAbsoluteDate(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatRelativeLabel(fromDate, toDate) {
    if (toDate <= fromDate) return "本日";
    let months = (toDate.getFullYear() - fromDate.getFullYear()) * 12 + (toDate.getMonth() - fromDate.getMonth());
    let stepped = addMonths(fromDate, months);
    if (stepped > toDate) {
      months -= 1;
      stepped = addMonths(fromDate, months);
    }
    const days = Math.round((toDate - stepped) / 86400000);
    if (months <= 0) return `${days}日後`;
    return `${months}ヶ月${days}日後`;
  }

  function formatNumber(n) {
    if (Number.isInteger(n)) return n.toLocaleString("ja-JP");
    return n.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  }

  // ---------- storage ----------

  function loadGoals() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function saveGoals(goals) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(goals));
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  let goals = loadGoals();

  function persist() {
    saveGoals(goals);
  }

  // ---------- calculation core ----------

  function computeAutoSum(goal, uptoDate) {
    if (goal.autoIncreaseEnabled === false) return 0;
    const excludedSet = new Set(goal.excludedDates);
    let cur = isoToDate(goal.startDate);
    if (goal.initialValueIncludesToday) cur = addDays(cur, 1);
    const end = uptoDate;
    let sum = 0;
    while (cur <= end) {
      if (!excludedSet.has(dateToIso(cur))) sum += goal.increment;
      cur = addDays(cur, 1);
    }
    return sum;
  }

  function computeManualSum(goal) {
    return goal.manualLogs.reduce((acc, log) => acc + log.value, 0);
  }

  function computeCurrentValue(goal, today) {
    const raw = (goal.initialValue || 0) + computeAutoSum(goal, today) + computeManualSum(goal);
    return Math.min(goal.target, Math.max(0, raw));
  }

  function computeEtaDate(startFrom, neededDays, excludedSet) {
    let cur = new Date(startFrom);
    let count = 0;
    // safety cap to avoid runaway loops
    for (let i = 0; i < 366 * 200; i++) {
      if (!excludedSet.has(dateToIso(cur))) {
        count++;
        if (count === neededDays) return cur;
      }
      cur = addDays(cur, 1);
    }
    return null;
  }

  function computeMilestoneInfo(goal, current, milestoneValue, today, rate) {
    const effRate = rate != null ? rate : goal.increment;
    const remaining = milestoneValue - current;
    if (remaining <= 0) {
      return { achieved: true, remaining: 0, etaDate: null, etaUnavailable: false };
    }
    if (!(effRate > 0)) {
      return { achieved: false, remaining, etaDate: null, etaUnavailable: true };
    }
    const neededDays = Math.ceil(remaining / effRate);
    const excludedSet = new Set(goal.excludedDates);
    const etaDate = computeEtaDate(addDays(today, 1), neededDays, excludedSet);
    return { achieved: false, remaining, etaDate, etaUnavailable: false };
  }

  function computeRequiredDailyPaceFor(goal, current, milestoneValue, deadlineDateIso, today) {
    const remaining = milestoneValue - current;
    if (remaining <= 0 || !deadlineDateIso) return 0;
    const deadline = isoToDate(deadlineDateIso);
    const excludedSet = new Set(goal.excludedDates);
    let validDays = 0;
    let cur = new Date(today);
    while (cur <= deadline) {
      if (!excludedSet.has(dateToIso(cur))) validDays++;
      cur = addDays(cur, 1);
    }
    if (validDays <= 0) return remaining;
    return remaining / validDays;
  }

  function computeRequiredDailyPace(goal, current, today) {
    return computeRequiredDailyPaceFor(goal, current, goal.target, goal.deadlineDate, today);
  }

  function effectiveRate(goal, current, today) {
    if (goal.goalType === "deadline") return computeRequiredDailyPace(goal, current, today);
    return goal.increment;
  }

  function findNearestSubgoal(goal, current) {
    const pending = goal.subGoals.filter((s) => s.value > current);
    if (pending.length === 0) return null;
    return pending.reduce((nearest, s) => (s.value < nearest.value ? s : nearest), pending[0]);
  }

  function formatSubgoalLabel(sub) {
    return `${sub.label || "サブ目標"}: ${formatNumber(sub.value)}`;
  }

  const SUBGOAL_COLORS = [
    "oklch(58% 0.15 255)",
    "oklch(60% 0.16 340)",
    "oklch(62% 0.14 60)",
    "oklch(58% 0.13 200)",
    "oklch(60% 0.15 300)",
    "oklch(60% 0.13 130)",
  ];

  function subgoalColor(goal, subId) {
    const sorted = [...goal.subGoals].sort((a, b) => a.value - b.value);
    const index = sorted.findIndex((s) => s.id === subId);
    return SUBGOAL_COLORS[Math.max(0, index) % SUBGOAL_COLORS.length];
  }

  function fillEtaCell(info, absEl, relEl) {
    if (info.achieved) {
      absEl.textContent = "達成済み";
      relEl.textContent = "-";
      return;
    }
    if (info.etaUnavailable || !info.etaDate) {
      absEl.textContent = "算出不可";
      relEl.textContent = "-";
      return;
    }
    const today = todayDate();
    absEl.textContent = formatAbsoluteDate(info.etaDate);
    relEl.textContent = formatRelativeLabel(today, info.etaDate);
  }

  function fillGoalMainTiles(goal, current, today, remainingEl, etaLabelEl, etaEl, etaRelLabelEl, etaRelEl) {
    const achieved = current >= goal.target;

    if (goal.goalType === "deadline") {
      etaLabelEl.textContent = "達成期限日";
      etaRelLabelEl.textContent = "1日あたり必要な値";
      remainingEl.textContent = achieved ? "0" : formatNumber(goal.target - current);
      etaEl.textContent = goal.deadlineDate ? formatAbsoluteDate(isoToDate(goal.deadlineDate)) : "未設定";
      if (achieved) {
        etaRelEl.textContent = "達成済み";
      } else {
        const pace = computeRequiredDailyPace(goal, current, today);
        etaRelEl.textContent = pace > 0 ? `${formatNumber(Math.ceil(pace))} / 日` : "-";
      }
      return achieved;
    }

    etaLabelEl.textContent = "達成予定日";
    etaRelLabelEl.textContent = "あと";
    const rate = effectiveRate(goal, current, today);
    const info = computeMilestoneInfo(goal, current, goal.target, today, rate);
    remainingEl.textContent = info.achieved ? "0" : formatNumber(info.remaining);
    fillEtaCell(info, etaEl, etaRelEl);
    return info.achieved;
  }

  function fillSubgoalTiles(goal, sub, current, today, remainingEl, etaLabelEl, etaEl, etaRelLabelEl, etaRelEl) {
    const achieved = current >= sub.value;

    if (goal.goalType === "deadline") {
      const deadlineIso = sub.deadlineDate || goal.deadlineDate;
      etaLabelEl.textContent = "達成期限日";
      etaRelLabelEl.textContent = "1日あたり必要な値";
      remainingEl.textContent = achieved ? "0" : formatNumber(sub.value - current);
      etaEl.textContent = deadlineIso ? formatAbsoluteDate(isoToDate(deadlineIso)) : "未設定";
      if (achieved) {
        etaRelEl.textContent = "達成済み";
      } else {
        const pace = computeRequiredDailyPaceFor(goal, current, sub.value, deadlineIso, today);
        etaRelEl.textContent = pace > 0 ? `${formatNumber(Math.ceil(pace))} / 日` : "-";
      }
      return achieved;
    }

    etaLabelEl.textContent = "達成予定日";
    etaRelLabelEl.textContent = "あと";
    const rate = effectiveRate(goal, current, today);
    const info = computeMilestoneInfo(goal, current, sub.value, today, rate);
    remainingEl.textContent = info.achieved ? "0" : formatNumber(info.remaining);
    fillEtaCell(info, etaEl, etaRelEl);
    return info.achieved;
  }

  // ---------- screen switching ----------

  const screens = {
    list: document.getElementById("screenList"),
    detail: document.getElementById("screenDetail"),
    add: document.getElementById("screenAdd"),
    addSubgoal: document.getElementById("screenAddSubgoal"),
  };

  function showScreen(name) {
    for (const key of Object.keys(screens)) {
      screens[key].hidden = key !== name;
    }
    window.scrollTo(0, 0);
  }

  function goToList() {
    renderList();
    showScreen("list");
  }

  // Swipe right anywhere on a non-list screen returns to the home (list) screen.
  function attachSwipeBack(screenEl) {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    screenEl.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1 || e.target.closest(".tab-row, input, textarea, select")) {
          tracking = false;
          return;
        }
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
      },
      { passive: true }
    );

    screenEl.addEventListener(
      "touchend",
      (e) => {
        if (!tracking) return;
        tracking = false;
        const touch = e.changedTouches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (dx > 80 && Math.abs(dy) < 60) goToList();
      },
      { passive: true }
    );

    screenEl.addEventListener("touchcancel", () => { tracking = false; }, { passive: true });
  }

  attachSwipeBack(screens.detail);
  attachSwipeBack(screens.add);
  attachSwipeBack(screens.addSubgoal);

  // ---------- list screen ----------

  const goalListEl = document.getElementById("goalList");
  const goalCardTemplate = document.getElementById("goalCardTemplate");

  function renderList() {
    const today = todayDate();
    goalListEl.innerHTML = "";

    if (goals.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "目標がまだありません。右上の + から追加してください。";
      goalListEl.appendChild(empty);
      return;
    }

    for (const goal of goals) {
      goalListEl.appendChild(renderGoalCard(goal, today));
    }
  }

  function renderGoalCard(goal, today) {
    const node = goalCardTemplate.content.firstElementChild.cloneNode(true);
    const current = computeCurrentValue(goal, today);
    const pct = Math.min(100, Math.round((current / goal.target) * 100));

    node.querySelector(".goal-card-name").textContent = goal.name;

    node.querySelector(".goal-card-percent").innerHTML = `${pct}<span class="unit">%</span>`;
    node.querySelector(".goal-card-numbers").textContent = `${formatNumber(current)} / ${formatNumber(goal.target)}`;

    const fillEl = node.querySelector(".progress-bar-fill");
    fillEl.style.width = `${pct}%`;

    const achieved = fillGoalMainTiles(
      goal,
      current,
      today,
      node.querySelector(".goal-card-remaining"),
      node.querySelector(".goal-card-eta-label"),
      node.querySelector(".goal-card-eta"),
      node.querySelector(".goal-card-eta-relative-label"),
      node.querySelector(".goal-card-eta-relative")
    );

    const statusEl = node.querySelector(".status-chip");
    statusEl.textContent = achieved ? "達成" : "進行中";
    statusEl.classList.toggle("achieved", achieved);
    fillEl.classList.toggle("achieved", achieved);

    const tilesEl = node.querySelector(".goal-card-tiles");
    tilesEl.hidden = achieved;

    const subgoalEl = node.querySelector(".goal-card-subgoal");
    const nearestSubgoal = findNearestSubgoal(goal, current);
    if (nearestSubgoal) {
      subgoalEl.hidden = false;
      const subPct = Math.min(100, Math.max(0, (current / nearestSubgoal.value) * 100));
      subgoalEl.querySelector(".goal-card-subgoal-label").textContent = formatSubgoalLabel(nearestSubgoal);

      const subAchieved = fillSubgoalTiles(
        goal,
        nearestSubgoal,
        current,
        today,
        subgoalEl.querySelector(".goal-card-subgoal-remaining"),
        subgoalEl.querySelector(".goal-card-subgoal-eta-label"),
        subgoalEl.querySelector(".goal-card-subgoal-eta"),
        subgoalEl.querySelector(".goal-card-subgoal-eta-relative-label"),
        subgoalEl.querySelector(".goal-card-subgoal-eta-relative")
      );

      const subFillEl = subgoalEl.querySelector(".goal-card-subgoal-fill");
      subFillEl.style.width = `${subPct}%`;
      if (subAchieved) {
        subFillEl.classList.add("achieved");
        subFillEl.style.background = "";
      } else {
        subFillEl.classList.remove("achieved");
        subFillEl.style.background = subgoalColor(goal, nearestSubgoal.id);
      }

      subgoalEl.addEventListener("click", (e) => {
        e.stopPropagation();
        openDetail(goal.id, "subgoals");
      });
    }

    node.addEventListener("click", () => openDetail(goal.id, "manual"));

    return node;
  }

  document.getElementById("openAddScreen").addEventListener("click", () => {
    document.getElementById("addGoalForm").reset();
    setAddGoalType("pace");
    document.getElementById("newGoalAutoIncrease").checked = true;
    showScreen("add");
  });

  // ---------- detail screen ----------

  let currentDetailGoalId = null;
  let currentDetailTab = "manual";

  function getCurrentDetailGoal() {
    return goals.find((g) => g.id === currentDetailGoalId) || null;
  }

  function openDetail(goalId, tab) {
    currentDetailGoalId = goalId;
    currentDetailTab = tab || "manual";
    renderDetailScreen();
    showScreen("detail");
  }

  function renderDetailScreen() {
    const goal = getCurrentDetailGoal();
    if (!goal) {
      goToList();
      return;
    }
    const today = todayDate();
    const current = computeCurrentValue(goal, today);

    document.getElementById("detailGoalName").textContent = goal.name;

    document.getElementById("detailCurrent").textContent = formatNumber(current);
    document.getElementById("detailTarget").textContent = formatNumber(goal.target);

    const pct = Math.min(100, (current / goal.target) * 100);
    const fillEl = document.getElementById("detailProgressFill");
    fillEl.style.width = `${pct}%`;

    const achieved = fillGoalMainTiles(
      goal,
      current,
      today,
      document.getElementById("detailRemaining"),
      document.getElementById("detailEtaLabel"),
      document.getElementById("detailEta"),
      document.getElementById("detailEtaRelativeLabel"),
      document.getElementById("detailEtaRelative")
    );

    const statusEl = document.getElementById("detailStatus");
    statusEl.textContent = achieved ? "達成" : "進行中";
    statusEl.classList.toggle("achieved", achieved);
    fillEl.classList.toggle("achieved", achieved);

    const plannedTabBtn = document.querySelector('.tab-btn[data-tab="planned"]');
    const isDeadlineType = goal.goalType === "deadline";
    plannedTabBtn.hidden = isDeadlineType;
    if (isDeadlineType && currentDetailTab === "planned") {
      currentDetailTab = "manual";
    }

    applyDetailTab();
    renderManualLogPanel(goal, today);
    if (!isDeadlineType) renderPlannedPanel(goal, today);
    renderExcludedDatePanel(goal);
    renderSubgoalPanel(goal, current, today);
  }

  function applyDetailTab() {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === currentDetailTab);
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.hidden = p.dataset.panel !== currentDetailTab;
    });
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentDetailTab = btn.dataset.tab;
      applyDetailTab();
    });
  });

  document.getElementById("backFromDetail").addEventListener("click", () => {
    currentDetailGoalId = null;
    goToList();
  });

  document.getElementById("deleteGoalBtn").addEventListener("click", () => {
    const goal = getCurrentDetailGoal();
    if (!goal) return;
    if (!confirm(`目標「${goal.name}」を削除しますか?`)) return;
    goals = goals.filter((g) => g.id !== goal.id);
    persist();
    currentDetailGoalId = null;
    goToList();
  });

  function handleDetailDataChange() {
    persist();
    renderDetailScreen();
  }

  // --- manual log tab ---

  const manualLogForm = document.getElementById("manualLogForm");
  const manualLogDateInput = document.getElementById("manualLogDate");
  const manualLogValueInput = document.getElementById("manualLogValue");
  const manualLogListEl = document.getElementById("manualLogList");
  const flatRowTemplate = document.getElementById("flatRowTemplate");

  function renderManualLogPanel(goal, today) {
    manualLogDateInput.max = dateToIso(today);
    if (!manualLogDateInput.value) manualLogDateInput.value = dateToIso(today);

    manualLogListEl.innerHTML = "";
    const sorted = [...goal.manualLogs].sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const log of sorted) {
      const li = flatRowTemplate.content.firstElementChild.cloneNode(true);
      li.querySelector(".flat-row-label").textContent = log.date;
      li.querySelector(".flat-row-value").textContent = `${log.value > 0 ? "+" : ""}${formatNumber(log.value)}`;
      li.querySelector(".flat-row-delete").addEventListener("click", () => {
        goal.manualLogs = goal.manualLogs.filter((l) => l.id !== log.id);
        handleDetailDataChange();
      });
      manualLogListEl.appendChild(li);
    }
  }

  manualLogForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const goal = getCurrentDetailGoal();
    if (!goal) return;
    const today = todayDate();
    const dateIso = manualLogDateInput.value;
    const value = Number(manualLogValueInput.value);
    if (!dateIso || Number.isNaN(value)) return;
    if (dateIso > dateToIso(today)) {
      alert("未来の日付には入力できません。");
      return;
    }
    if (goal.excludedDates.includes(dateIso)) {
      alert("この日は除外日のため入力できません。");
      return;
    }
    goal.manualLogs.push({ id: uid(), date: dateIso, value });
    handleDetailDataChange();
  });

  // --- planned increases tab ---

  const plannedForm = document.getElementById("plannedForm");
  const plannedDateInput = document.getElementById("plannedDate");
  const plannedValueInput = document.getElementById("plannedValue");
  const plannedListEl = document.getElementById("plannedList");
  const plannedCardTemplate = document.getElementById("plannedCardTemplate");
  const plannedImpactTemplate = document.getElementById("plannedImpactTemplate");

  function computePlannedChain(goal, sortedEntries) {
    let runningOffset = 0;
    const steps = [];
    for (const entry of sortedEntries) {
      const anchor = isoToDate(entry.date);
      const beforeValue = Math.min(goal.target, Math.max(0, computeCurrentValue(goal, anchor) + runningOffset));
      const afterValue = Math.min(goal.target, Math.max(0, beforeValue + entry.value));
      steps.push({ entry, anchor, beforeValue, afterValue });
      runningOffset += entry.value;
    }
    return steps;
  }

  function computeMilestoneImpactForStep(goal, step, milestoneValue) {
    const baselineRate = effectiveRate(goal, step.beforeValue, step.anchor);
    const withPlanRate = effectiveRate(goal, step.afterValue, step.anchor);
    const baseline = computeMilestoneInfo(goal, step.beforeValue, milestoneValue, step.anchor, baselineRate);
    const withPlan = computeMilestoneInfo(goal, step.afterValue, milestoneValue, step.anchor, withPlanRate);
    const neededAfter = Math.max(0, milestoneValue - step.afterValue);

    let deltaDays = null;
    if (!baseline.achieved) {
      const withPlanEtaEffective = withPlan.achieved ? step.anchor : withPlan.etaDate;
      if (baseline.etaDate && withPlanEtaEffective) {
        deltaDays = Math.round((baseline.etaDate - withPlanEtaEffective) / 86400000);
      }
    }

    return {
      beforeValue: step.beforeValue,
      afterValue: step.afterValue,
      baseline,
      withPlan,
      deltaDays,
      anchor: step.anchor,
      neededAfter,
    };
  }

  function plannedImpactSortKey(impact, anchor) {
    if (impact.withPlan.achieved) return anchor;
    if (impact.withPlan.etaUnavailable || !impact.withPlan.etaDate) return null;
    return impact.withPlan.etaDate;
  }

  function renderPlannedImpactBlock(container, label, dotColor, impact) {
    const node = plannedImpactTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".planned-impact-label").textContent = label;
    if (dotColor) node.style.setProperty("--dot-color", dotColor);

    node.querySelector(".planned-before").textContent = formatNumber(impact.beforeValue);
    node.querySelector(".planned-after").textContent = formatNumber(impact.afterValue);
    node.querySelector(".planned-needed").textContent = formatNumber(impact.neededAfter);

    const deltaEl = node.querySelector(".planned-delta");
    if (impact.deltaDays === null) {
      deltaEl.textContent = "算出不可";
    } else if (impact.deltaDays > 0) {
      deltaEl.textContent = `${impact.deltaDays}日短縮`;
    } else if (impact.deltaDays < 0) {
      deltaEl.textContent = `${-impact.deltaDays}日延長`;
    } else {
      deltaEl.textContent = "変化なし";
    }

    const etaEl = node.querySelector(".planned-eta");
    const etaRelEl = node.querySelector(".planned-eta-relative");
    if (impact.withPlan.achieved) {
      etaEl.textContent = `${formatAbsoluteDate(impact.anchor)}(達成)`;
      etaRelEl.textContent = formatRelativeLabel(impact.anchor, impact.anchor);
    } else if (impact.withPlan.etaUnavailable || !impact.withPlan.etaDate) {
      etaEl.textContent = "算出不可";
      etaRelEl.textContent = "-";
    } else {
      etaEl.textContent = formatAbsoluteDate(impact.withPlan.etaDate);
      etaRelEl.textContent = formatRelativeLabel(impact.anchor, impact.withPlan.etaDate);
    }

    container.appendChild(node);
  }

  function renderPlannedPanel(goal, today) {
    plannedListEl.innerHTML = "";
    const entries = [...(goal.plannedIncreases || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
    const chain = computePlannedChain(goal, entries);

    for (const step of chain) {
      const li = plannedCardTemplate.content.firstElementChild.cloneNode(true);
      li.querySelector(".planned-card-date").textContent = step.entry.date;
      li.querySelector(".planned-card-value").textContent = `${step.entry.value > 0 ? "+" : ""}${formatNumber(step.entry.value)}`;
      li.querySelector(".planned-delete").addEventListener("click", () => {
        goal.plannedIncreases = goal.plannedIncreases.filter((p) => p.id !== step.entry.id);
        handleDetailDataChange();
      });

      // Only not-yet-achieved sub-goals, nearest-to-achievement first, capped at 2.
      const subgoalListContainer = li.querySelector(".planned-subgoal-list");
      const subgoalImpacts = goal.subGoals
        .map((sub) => ({ sub, impact: computeMilestoneImpactForStep(goal, step, sub.value) }))
        .filter(({ impact }) => !impact.baseline.achieved)
        .sort((a, b) => {
          const da = plannedImpactSortKey(a.impact, step.anchor);
          const db = plannedImpactSortKey(b.impact, step.anchor);
          if (da === null && db === null) return 0;
          if (da === null) return 1;
          if (db === null) return -1;
          return da - db;
        })
        .slice(0, 2);
      for (const { sub, impact } of subgoalImpacts) {
        renderPlannedImpactBlock(subgoalListContainer, formatSubgoalLabel(sub), subgoalColor(goal, sub.id), impact);
      }

      const mainImpact = computeMilestoneImpactForStep(goal, step, goal.target);
      const mainEl = li.querySelector(".planned-main");
      if (mainImpact.baseline.achieved) {
        mainEl.hidden = true;
      } else {
        renderPlannedImpactBlock(mainEl, "メイン目標", null, mainImpact);
      }

      plannedListEl.appendChild(li);
    }
  }

  plannedForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const goal = getCurrentDetailGoal();
    if (!goal) return;
    const dateIso = plannedDateInput.value;
    const value = Number(plannedValueInput.value);
    if (!dateIso || Number.isNaN(value)) return;
    if (!goal.plannedIncreases) goal.plannedIncreases = [];
    const existing = goal.plannedIncreases.find((p) => p.date === dateIso);
    if (existing) {
      existing.value += value;
    } else {
      goal.plannedIncreases.push({ id: uid(), date: dateIso, value });
    }
    plannedValueInput.value = "";
    handleDetailDataChange();
  });

  // --- excluded date tab ---

  const excludedDateForm = document.getElementById("excludedDateForm");
  const excludedDateInput = document.getElementById("excludedDateInput");
  const excludedDateListEl = document.getElementById("excludedDateList");

  function renderExcludedDatePanel(goal) {
    excludedDateListEl.innerHTML = "";
    const sorted = [...goal.excludedDates].sort((a, b) => (a < b ? 1 : -1));
    for (const iso of sorted) {
      const li = flatRowTemplate.content.firstElementChild.cloneNode(true);
      li.querySelector(".flat-row-label").textContent = iso;
      li.querySelector(".flat-row-value").remove();
      li.querySelector(".flat-row-delete").addEventListener("click", () => {
        goal.excludedDates = goal.excludedDates.filter((d) => d !== iso);
        handleDetailDataChange();
      });
      excludedDateListEl.appendChild(li);
    }
  }

  excludedDateForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const goal = getCurrentDetailGoal();
    if (!goal) return;
    const dateIso = excludedDateInput.value;
    if (!dateIso) return;
    if (goal.excludedDates.includes(dateIso)) {
      alert("すでに除外日として登録されています。");
      return;
    }
    goal.excludedDates.push(dateIso);
    excludedDateInput.value = "";
    handleDetailDataChange();
  });

  // --- subgoals tab ---

  const subgoalListEl = document.getElementById("subgoalList");
  const subgoalRowTemplate = document.getElementById("subgoalRowTemplate");

  function renderSubgoalPanel(goal, current, today) {
    subgoalListEl.innerHTML = "";
    const sorted = [...goal.subGoals].sort((a, b) => a.value - b.value);
    for (const sub of sorted) {
      const li = subgoalRowTemplate.content.firstElementChild.cloneNode(true);

      li.querySelector(".subgoal-row-label").textContent = formatSubgoalLabel(sub);

      const achieved = fillSubgoalTiles(
        goal,
        sub,
        current,
        today,
        li.querySelector(".subgoal-row-remaining"),
        li.querySelector(".subgoal-row-eta-label"),
        li.querySelector(".subgoal-row-eta"),
        li.querySelector(".subgoal-row-eta-relative-label"),
        li.querySelector(".subgoal-row-eta-relative")
      );

      const statusEl = li.querySelector(".subgoal-row-status");
      statusEl.textContent = achieved ? "達成" : "進行中";
      statusEl.classList.toggle("achieved", achieved);

      const subPct = Math.min(100, Math.max(0, (current / sub.value) * 100));
      const subFillEl = li.querySelector(".subgoal-row-fill");
      subFillEl.style.width = `${subPct}%`;
      if (achieved) {
        subFillEl.classList.add("achieved");
      } else {
        subFillEl.style.background = subgoalColor(goal, sub.id);
      }

      li.querySelector(".subgoal-row-delete").addEventListener("click", () => {
        goal.subGoals = goal.subGoals.filter((s) => s.id !== sub.id);
        handleDetailDataChange();
      });

      subgoalListEl.appendChild(li);
    }
  }

  document.getElementById("openAddSubgoalScreen").addEventListener("click", () => {
    document.getElementById("addSubgoalForm").reset();
    const goal = getCurrentDetailGoal();
    const isDeadlineType = !!goal && goal.goalType === "deadline";
    document.getElementById("newSubgoalDeadlineField").hidden = !isDeadlineType;
    document.getElementById("newSubgoalDeadline").required = isDeadlineType;
    showScreen("addSubgoal");
  });

  // ---------- add-subgoal screen ----------

  const addSubgoalForm = document.getElementById("addSubgoalForm");

  document.getElementById("backFromAddSubgoal").addEventListener("click", () => {
    showScreen("detail");
  });

  addSubgoalForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const goal = getCurrentDetailGoal();
    if (!goal) {
      goToList();
      return;
    }
    const label = document.getElementById("newSubgoalLabel").value.trim();
    const value = Number(document.getElementById("newSubgoalValue").value);
    if (Number.isNaN(value)) return;

    const sub = { id: uid(), label, value };
    if (goal.goalType === "deadline") {
      const deadlineRaw = document.getElementById("newSubgoalDeadline").value;
      if (!deadlineRaw) {
        alert("達成期限日を入力してください。");
        return;
      }
      sub.deadlineDate = deadlineRaw;
    }

    goal.subGoals.push(sub);
    persist();
    renderDetailScreen();
    showScreen("detail");
  });

  // ---------- add screen ----------

  const addGoalForm = document.getElementById("addGoalForm");
  const paceFieldsEl = document.getElementById("paceFields");
  const deadlineFieldsEl = document.getElementById("deadlineFields");
  const typeHintEl = document.getElementById("typeHint");
  const newGoalIncrementInput = document.getElementById("newGoalIncrement");
  const newGoalDeadlineInput = document.getElementById("newGoalDeadline");
  let currentAddGoalType = "pace";

  const TYPE_HINTS = {
    pace: "1日あたりの増加値を決めて、達成予定日を自動計算します。",
    deadline: "達成期限日を決めて、1日あたりに必要な値を自動計算します。",
  };

  function setAddGoalType(type) {
    currentAddGoalType = type;
    document.querySelectorAll(".type-toggle-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === type);
    });
    const isPace = type === "pace";
    paceFieldsEl.hidden = !isPace;
    deadlineFieldsEl.hidden = isPace;
    newGoalIncrementInput.required = isPace;
    newGoalDeadlineInput.required = !isPace;
    typeHintEl.textContent = TYPE_HINTS[type];
  }

  document.querySelectorAll(".type-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => setAddGoalType(btn.dataset.type));
  });

  document.getElementById("backFromAdd").addEventListener("click", () => {
    showScreen("list");
  });

  addGoalForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("newGoalName").value.trim();
    const target = Number(document.getElementById("newGoalTarget").value);
    const initialValueRaw = document.getElementById("newGoalInitialValue").value;
    const initialValue = initialValueRaw === "" ? 0 : Number(initialValueRaw);

    if (!name || Number.isNaN(target) || Number.isNaN(initialValue) || target <= 0 || initialValue < 0) {
      alert("目標名・目標値を正しく入力してください(目標値は0より大きい数、現在値は0以上)。");
      return;
    }

    const baseGoal = {
      id: uid(),
      name,
      target,
      initialValue,
      startDate: dateToIso(todayDate()),
      excludedDates: [],
      manualLogs: [],
      subGoals: [],
      plannedIncreases: [],
    };

    if (currentAddGoalType === "pace") {
      const increment = Number(newGoalIncrementInput.value);
      const initialValueIncludesToday = document.getElementById("newGoalInitialIncludesToday").checked;
      const autoIncreaseEnabled = document.getElementById("newGoalAutoIncrease").checked;
      if (Number.isNaN(increment) || increment <= 0) {
        alert("1日あたりの増加値を正しく入力してください(0より大きい数)。");
        return;
      }
      goals.push({
        ...baseGoal,
        goalType: "pace",
        increment,
        initialValueIncludesToday,
        autoIncreaseEnabled,
      });
    } else {
      const deadlineRaw = newGoalDeadlineInput.value;
      if (!deadlineRaw) {
        alert("達成期限日を入力してください。");
        return;
      }
      goals.push({
        ...baseGoal,
        goalType: "deadline",
        increment: 0,
        initialValueIncludesToday: false,
        autoIncreaseEnabled: false,
        deadlineDate: deadlineRaw,
      });
    }

    persist();
    goToList();
  });

  // ---------- init ----------

  renderList();
  showScreen("list");

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
