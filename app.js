const STORAGE_KEY = "homeLedgerDataV1";
const TEXT_SIZE_KEY = "homeLedgerLargeText";
const REMEMBERED_USERNAME_KEY = "homeLedgerRememberedUsername";
const AUTH_PROFILE_KEY = "homeLedgerAuthenticatedProfile";
const SUPABASE_URL = "https://xhgvuyvnogykvrzevbcz.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_Ys39GBofm3_9Y9Rwm1Xmdw_LO5tHlS3";
const HOUSEHOLD_ID = "bc104ce3-48d1-49ad-a948-746c14707fa3";
const AUTH_PROFILES = Object.freeze({
  tdw24: "Tyrone",
  pcmw7: "Pamela",
});
const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
);

const categories = [
  "Housing",
  "Utilities",
  "Food & household",
  "Transportation",
  "Subscriptions",
  "Business",
  "Insurance",
  "Education",
  "Medical",
  "Debt payments",
  "Personal",
  "Banking",
  "Unassigned",
];

const affirmations = [
  "Every dollar tracked builds confidence.",
  "Awareness today creates more freedom tomorrow.",
  "Small, consistent choices create lasting progress.",
  "You are building clarity one expense at a time.",
  "Progress matters more than perfection.",
  "Your family is moving forward together.",
];

const defaultExpenses = [];

function currentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function normalizePayer(payer) {
  return payer === "Pamela" ? "Pamela" : "Tyrone";
}

const DEFAULT_TAX_RATES = Object.freeze({
  federal: 12,
  california: 9.3,
  selfEmployment: 15.3,
});

const defaultState = {
  expenses: defaultExpenses.map((expense) => ({
    ...expense,
    payer: normalizePayer(expense.payer),
  })),
  taxRates: { ...DEFAULT_TAX_RATES },
  debtBaseline: 0,
  currentMonth: currentMonthValue(),
  importedBenchmarks: {
    actualWeekly: 0,
    payingWeekly: 0,
    weeklyOverage: 0,
    actualAnnual: 0,
    payingAnnual: 0,
    annualOverage: 0,
    payingNowMonthly: 0,
    monthlyOverage: 0,
  },
};

let state = loadState();
let activeUser = null;
let currentSection = "overview";
let currentAuthUser = null;
let cloudReady = false;
let cloudSaveTimer;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(defaultState));
}

function normalizeState(saved) {
  if (!saved?.expenses) return cloneDefaultState();

  const defaultsById = new Map(
    defaultExpenses.map((expense) => [expense.id, expense]),
  );
  const migratedExpenses = saved.expenses.map((expense) => {
    const defaultExpense = defaultsById.get(expense.id);
    const hasSavedRate = Object.prototype.hasOwnProperty.call(
      expense,
      "interestRate",
    );
    return {
      ...expense,
      payer: normalizePayer(expense.payer),
      interestRate: hasSavedRate
        ? expense.interestRate
        : (defaultExpense?.interestRate ?? null),
      estimatedPayoffDate: Object.prototype.hasOwnProperty.call(
        expense,
        "estimatedPayoffDate",
      )
        ? expense.estimatedPayoffDate
        : (defaultExpense?.estimatedPayoffDate ?? ""),
    };
  });
  const {
    incomes: _legacyIncomes,
    sharedSplit: _legacySharedSplit,
    monthlyIncomeNeed: _legacyMonthlyIncomeNeed,
    ...savedWithoutLegacyFields
  } = saved;
  const activeDebtTotal = migratedExpenses
    .filter((item) => item.balance && !item.inactive)
    .reduce((sum, item) => sum + Number(item.balance || 0), 0);

  return {
    ...cloneDefaultState(),
    ...savedWithoutLegacyFields,
    taxRates: {
      federal: normalizeTaxRate(
        saved.taxRates?.federal,
        DEFAULT_TAX_RATES.federal,
      ),
      california: normalizeTaxRate(
        saved.taxRates?.california,
        DEFAULT_TAX_RATES.california,
      ),
      selfEmployment: normalizeTaxRate(
        saved.taxRates?.selfEmployment,
        DEFAULT_TAX_RATES.selfEmployment,
      ),
    },
    debtBaseline:
      Number(saved.debtBaseline) > 0
        ? Number(saved.debtBaseline)
        : activeDebtTotal,
    currentMonth: currentMonthValue(),
    expenses: migratedExpenses,
    importedBenchmarks: {
      ...defaultState.importedBenchmarks,
      ...(saved.importedBenchmarks || {}),
    },
  };
}

function loadState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch (error) {
    console.warn("Could not load saved HomeLedger data.", error);
    return cloneDefaultState();
  }
}

function saveState({ syncCloud = true } = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (syncCloud && cloudReady && currentAuthUser) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = window.setTimeout(() => {
      pushHouseholdState().catch((error) => {
        console.warn("Could not sync HomeLedger data.", error);
      });
    }, 350);
  }
}

async function pushHouseholdState({ showConfirmation = false } = {}) {
  if (!cloudReady || !currentAuthUser) return;

  const updatedAt = new Date().toISOString();
  const snapshot = JSON.parse(JSON.stringify(state));
  snapshot.lastSyncedAt = updatedAt;
  const { data, error } = await supabaseClient
    .from("household_state")
    .update({
      state: snapshot,
      updated_at: updatedAt,
      updated_by: currentAuthUser.id,
    })
    .eq("household_id", HOUSEHOLD_ID)
    .select("updated_at")
    .single();

  if (error) throw error;

  state.lastSyncedAt = data.updated_at;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  $("#syncStatus").textContent =
    `Cloud synced ${new Date(data.updated_at).toLocaleString()}.`;
  if (showConfirmation) showToast("Household data synced");
}

async function loadHouseholdState() {
  const localState = loadState();
  const { data, error } = await supabaseClient
    .from("household_state")
    .select("state, updated_at")
    .eq("household_id", HOUSEHOLD_ID)
    .single();

  if (error) {
    throw new Error(
      "Cloud storage is not ready. Run supabase-setup.sql in the Supabase SQL Editor.",
    );
  }

  const cloudHasExpenses =
    Array.isArray(data.state?.expenses) && data.state.expenses.length > 0;
  state = cloudHasExpenses ? normalizeState(data.state) : localState;
  state.currentMonth = currentMonthValue();
  cloudReady = true;
  saveState({ syncCloud: false });

  await pushHouseholdState();
}

function money(value, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value) || 0);
}

function normalizeTaxRate(value, fallback = 0) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : fallback;
}

function incomeNeedEstimate(outflow, rates = state.taxRates) {
  const combinedRate =
    normalizeTaxRate(rates?.federal) +
    normalizeTaxRate(rates?.california) +
    normalizeTaxRate(rates?.selfEmployment);
  const takeHomeRate = 1 - combinedRate / 100;
  const monthlyGross = takeHomeRate > 0 ? outflow / takeHomeRate : 0;

  return {
    combinedRate,
    monthlyGross,
    annualGross: monthlyGross * 12,
  };
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isDebtItem(item) {
  return Boolean(item?.isDebt || item?.category === "Debt payments");
}

function hasInterestRate(item) {
  return (
    item?.interestRate !== null &&
    item?.interestRate !== undefined &&
    item?.interestRate !== ""
  );
}

function debtProjection(item) {
  if (item?.balance === null || item?.balance === undefined) return null;

  const startingBalance = Math.max(0, Number(item.balance) || 0);
  const payment = Math.max(0, Number(item.amount) || 0);
  const annualRate = Math.max(0, Number(item.interestRate) || 0);
  const monthlyInterest = startingBalance * (annualRate / 100 / 12);
  const amountDue = startingBalance + monthlyInterest;
  const paymentApplied = Math.min(payment, amountDue);
  const principalPaid = Math.max(0, paymentApplied - monthlyInterest);
  const endingBalance = Math.max(0, amountDue - paymentApplied);

  return {
    startingBalance,
    payment,
    annualRate,
    monthlyInterest,
    paymentApplied,
    principalPaid,
    endingBalance,
  };
}

function monthsUntilPayoff(payoffDate) {
  if (!payoffDate || !state.currentMonth) return null;
  const [startYear, startMonth] = state.currentMonth.split("-").map(Number);
  const [endYear, endMonth] = payoffDate.split("-").map(Number);
  if (![startYear, startMonth, endYear, endMonth].every(Number.isFinite)) {
    return null;
  }

  const monthCount =
    endYear * 12 + (endMonth - 1) - (startYear * 12 + (startMonth - 1));
  if (monthCount < 0) return null;
  return Math.max(1, monthCount);
}

function estimateStartingBalance(payment, annualRate, paymentCount) {
  const monthlyPayment = Math.max(0, Number(payment) || 0);
  const periods = Math.max(1, Number(paymentCount) || 1);
  const monthlyRate = Math.max(0, Number(annualRate) || 0) / 100 / 12;

  if (monthlyRate === 0) return monthlyPayment * periods;
  return (
    monthlyPayment *
    ((1 - Math.pow(1 + monthlyRate, -periods)) / monthlyRate)
  );
}

function balanceCell(item) {
  if (item.balance === null || item.balance === undefined) return "—";
  const estimatedTag = item.balanceEstimated
    ? '<span class="estimated-tag">Est.</span>'
    : "";
  if (!isDebtItem(item)) {
    return `<strong>${money(item.balance)} ${estimatedTag}</strong>`;
  }
  if (!hasInterestRate(item)) {
    return `
      <strong>${money(item.balance)} ${estimatedTag}</strong>
      <small class="rate-warning">APR needed</small>
    `;
  }

  const projection = debtProjection(item);
  return `
    <strong>${money(item.balance)} ${estimatedTag}</strong>
    <small>${Number(item.interestRate).toFixed(2)}% APR · ${money(
      projection.endingBalance,
    )} next</small>
  `;
}

function totals() {
  const outflow = state.expenses.reduce((sum, item) => sum + item.amount, 0);
  const incomeEstimate = incomeNeedEstimate(outflow);
  const income = incomeEstimate.monthlyGross;
  const activeDebt = state.expenses
    .filter((item) => item.balance && !item.inactive)
    .reduce((sum, item) => sum + item.balance, 0);
  const debtPayments = state.expenses
    .filter((item) => item.isDebt)
    .reduce((sum, item) => sum + item.amount, 0);
  const projectedDebt = state.expenses
    .filter((item) => item.balance && !item.inactive)
    .reduce((sum, item) => {
      const projection =
        isDebtItem(item) && hasInterestRate(item)
          ? debtProjection(item)
          : null;
      return sum + (projection?.endingBalance ?? item.balance);
    }, 0);
  const tyroneDirect = state.expenses
    .filter((item) => item.payer === "Tyrone")
    .reduce((sum, item) => sum + item.amount, 0);
  const pamelaDirect = state.expenses
    .filter((item) => item.payer === "Pamela")
    .reduce((sum, item) => sum + item.amount, 0);

  return {
    outflow,
    income,
    combinedTaxRate: incomeEstimate.combinedRate,
    activeDebt,
    projectedDebt,
    debtPayments,
    tyronePays: tyroneDirect,
    pamelaPays: pamelaDirect,
  };
}

function renderAll() {
  renderHeader();
  renderOverview();
  renderExpenseTable();
  renderDebts();
  renderSettings();
}

function renderHeader() {
  const month = new Date(`${state.currentMonth}-02T12:00:00`);
  const monthName = month.toLocaleDateString("en-US", { month: "long" });
  const abbreviatedMonth = month.toLocaleDateString("en-US", {
    month: "short",
  });
  const year = month.getFullYear();
  const sectionTitles = {
    overview: `${monthName} overview`,
    expenses: `${monthName} expenses`,
    debts: "Debt balances",
    settings: "Household settings",
  };

  $("#pageTitleDesktop").textContent = sectionTitles[currentSection];
  $("#pageTitleMobile").textContent =
    currentSection === "overview"
      ? `${abbreviatedMonth} ${year}`
      : sectionTitles[currentSection];
  $("#currentMonth").value = state.currentMonth;
  $("#overviewSubtitle").textContent =
    `${monthName} household expenses at a glance.`;
  $("#loginGreeting").textContent = greeting();
  $("#profileName").textContent = activeUser || "Tyrone";
  $("#avatar").textContent = (activeUser || "Tyrone").charAt(0);
  $("#welcomeHeading").textContent = `${greeting()}, ${activeUser || "Tyrone"}`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function affirmationIndexForDate(date = new Date()) {
  const effectiveDate = new Date(date.getTime() - 60 * 60 * 1000);
  const dayNumber = Math.floor(
    Date.UTC(
      effectiveDate.getFullYear(),
      effectiveDate.getMonth(),
      effectiveDate.getDate(),
    ) /
      (24 * 60 * 60 * 1000),
  );
  return dayNumber % affirmations.length;
}

function showDailyAffirmation({ animate = false } = {}) {
  const element = $("#affirmationText");
  const update = () => {
    element.textContent = affirmations[affirmationIndexForDate()];
    element.classList.remove("changing");
  };

  if (!animate) {
    update();
    return;
  }

  element.classList.add("changing");
  window.setTimeout(update, 180);
}

function scheduleDailyAffirmation() {
  showDailyAffirmation();
  const now = new Date();
  const nextChange = new Date(now);
  nextChange.setHours(1, 0, 0, 0);
  if (nextChange <= now) nextChange.setDate(nextChange.getDate() + 1);

  window.setTimeout(() => {
    showDailyAffirmation({ animate: true });
    scheduleDailyAffirmation();
  }, nextChange.getTime() - now.getTime());
}

function renderOverview() {
  const values = totals();
  const debtBaseline =
    Number(state.debtBaseline) > 0
      ? Number(state.debtBaseline)
      : values.activeDebt || 1;
  const reconciliation = values.activeDebt - debtBaseline;
  const debtPaidPercent =
    ((debtBaseline - values.activeDebt) / debtBaseline) * 100;
  const displayedPaidPercent = Math.max(0, Math.min(100, debtPaidPercent));
  const remainingPercent = Math.max(
    0,
    (values.activeDebt / debtBaseline) * 100,
  );

  $("#totalOutflow").textContent = money(values.outflow);
  $("#householdIncome").textContent = money(values.income);
  $("#debtBalance").textContent = money(values.activeDebt);
  $("#debtPayoffPercent").textContent =
    `${displayedPaidPercent.toFixed(1)}% paid off`;
  $("#debtPayoffProgress").style.width = `${displayedPaidPercent}%`;
  $("#debtPayoffCaption").textContent =
    debtPaidPercent < 0
      ? `${remainingPercent.toFixed(1)}% remaining · ${money(
          Math.abs(debtBaseline - values.activeDebt),
        )} above starting balance`
      : `${remainingPercent.toFixed(1)}% remaining · ${money(
          values.activeDebt,
        )} left`;

  renderCategories(values.outflow);
  renderLargestExpenses();
  renderBenchmarks();

  $("#reconciliationValue").textContent = `${
    reconciliation >= 0 ? "+" : "−"
  }${money(Math.abs(reconciliation))}`;
}

function renderBenchmarks() {
  const benchmarks = state.importedBenchmarks || {};
  $("#benchmarkActualWeekly").textContent = money(benchmarks.actualWeekly);
  $("#benchmarkPayingWeekly").textContent = money(benchmarks.payingWeekly);
  $("#benchmarkWeeklyOverage").textContent = money(benchmarks.weeklyOverage);
  $("#benchmarkActualAnnual").textContent = money(benchmarks.actualAnnual);
  $("#benchmarkPayingAnnual").textContent = money(benchmarks.payingAnnual);
  $("#benchmarkAnnualOverage").textContent = money(benchmarks.annualOverage);
  $("#benchmarkPayingMonthly").textContent =
    `${money(benchmarks.payingNowMonthly)}/mo`;
  $("#benchmarkMonthlyOverage").textContent = money(
    benchmarks.monthlyOverage,
  );
}

function renderCategories(totalOutflow) {
  const grouped = state.expenses.reduce((result, item) => {
    result[item.category] = (result[item.category] || 0) + item.amount;
    return result;
  }, {});
  const rows = Object.entries(grouped)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);
  const maximum = Math.max(...rows.map(([, value]) => value), 1);
  const colors = [
    "var(--forest-2)",
    "var(--blue)",
    "var(--orange)",
    "var(--mint-strong)",
    "#81938c",
    "#678676",
    "#9a806d",
  ];

  $("#categoryChart").innerHTML = rows
    .map(
      ([category, value], index) => `
        <div class="category-row">
          <div class="category-label">
            <span class="category-swatch" style="background:${colors[index]}"></span>
            <span>${escapeHtml(category)}</span>
          </div>
          <div class="category-bar">
            <span style="width:${(value / maximum) * 100}%;background:${colors[index]}"></span>
          </div>
          <div class="category-value">
            ${money(value)} <small>${((value / totalOutflow) * 100).toFixed(0)}%</small>
          </div>
        </div>`,
    )
    .join("");
}

function renderLargestExpenses() {
  const largest = [...state.expenses]
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  $("#largestExpenses").innerHTML = largest
    .map(
      (item) => `
        <div class="upcoming-item">
          <span class="bill-icon">${escapeHtml(item.name.slice(0, 2).toUpperCase())}</span>
          <span>
            <strong>${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(item.category)} · ${escapeHtml(item.payer)}</small>
          </span>
          <strong class="upcoming-amount">${money(item.amount)}</strong>
        </div>`,
    )
    .join("");
}

function filteredExpenses() {
  const search = $("#expenseSearch")?.value.trim().toLowerCase() || "";
  const category = $("#categoryFilter")?.value || "All";
  const payer = $("#payerFilter")?.value || "All";

  return state.expenses.filter((item) => {
    const searchable = `${item.name} ${item.notes} ${item.group}`.toLowerCase();
    return (
      (!search || searchable.includes(search)) &&
      (category === "All" || item.category === category) &&
      (payer === "All" || item.payer === payer)
    );
  });
}

function renderPayerSummary() {
  const payerStyles = {
    Tyrone: "tyrone",
    Pamela: "pamela",
  };
  $("#payerSummary").innerHTML = ["Tyrone", "Pamela"]
    .map((payer) => {
      const assigned = state.expenses.filter(
        (item) => item.payer === payer && item.amount > 0,
      );
      const amount = assigned.reduce((sum, item) => sum + item.amount, 0);
      return `
        <article class="payer-summary-card ${payerStyles[payer]}">
          <span class="payer-summary-dot ${payerStyles[payer]}"></span>
          <span>
            <small>Payer</small>
            <strong>${payer}</strong>
          </span>
          <span class="payer-summary-total">
            <strong>${money(amount)}</strong>
            <small>${assigned.length} ${assigned.length === 1 ? "bill" : "bills"}</small>
          </span>
        </article>
      `;
    })
    .join("");
}

function renderExpenseTable() {
  const expenses = filteredExpenses();
  renderPayerSummary();
  $("#expenseTableBody").innerHTML = expenses
    .map(
      (item) => `
        <tr
          class="expense-row payer-${item.payer.toLowerCase()}"
          data-expense-id="${item.id}"
          tabindex="0"
          role="button"
          aria-expanded="false"
          aria-label="View details for ${escapeHtml(item.name)}"
        >
          <td class="bill-cell"><strong>${escapeHtml(item.name)}</strong><br><small>${escapeHtml(item.group)}</small></td>
          <td data-label="Category"><span class="category-pill">${escapeHtml(item.category)}</span></td>
          <td data-label="Payer"><span class="payer-pill ${item.payer.toLowerCase()}">${escapeHtml(item.payer)}</span></td>
          <td class="amount" data-label="Monthly"><strong>${money(item.amount)}</strong></td>
          <td class="balance" data-label="Balance">${balanceCell(item)}</td>
          <td class="notes-cell" data-label="Notes" title="${escapeHtml(item.notes)}">${item.notes ? escapeHtml(item.notes) : "—"}</td>
          <td class="actions-cell">
            <div class="row-actions">
              <button class="row-button edit" data-edit="${item.id}" aria-label="Edit ${escapeHtml(item.name)}">•••</button>
            </div>
          </td>
        </tr>`,
    )
    .join("");
  $("#tableCount").textContent = `${expenses.length} ${
    expenses.length === 1 ? "expense" : "expenses"
  }`;
  $("#tableTotal").textContent = money(
    expenses.reduce((sum, item) => sum + item.amount, 0),
  );
}

function renderDebts() {
  const values = totals();
  const debtBaseline =
    Number(state.debtBaseline) > 0
      ? Number(state.debtBaseline)
      : values.activeDebt || 0;
  const reconciliation = values.activeDebt - debtBaseline;
  const debts = state.expenses.filter(
    (item) => item.isDebt || item.balance != null,
  );

  $("#debtPageTotal").textContent = money(values.activeDebt);
  $("#debtPayments").textContent = money(values.debtPayments);
  $("#reconciliationValue").textContent = `${
    reconciliation >= 0 ? "+" : "−"
  }${money(Math.abs(reconciliation))}`;
  $("#reconciliationNote").querySelector("p").textContent =
    `The entered active balances total ${money(values.activeDebt)}, which is ` +
    `${money(Math.abs(reconciliation))} ${
      reconciliation >= 0 ? "above" : "below"
    } the starting debt total of ${money(debtBaseline)}.`;

  $("#debtList").innerHTML = debts
    .map((item) => {
      const projection =
        hasInterestRate(item) && item.balance != null
          ? debtProjection(item)
          : null;
      return `
        <article
          class="debt-card"
          data-debt-edit="${item.id}"
          tabindex="0"
          role="button"
          aria-label="Edit ${escapeHtml(item.name)}"
        >
          <div class="debt-card-top">
            <div>
              <h3>${escapeHtml(item.name)}</h3>
              <p>${escapeHtml(item.notes || (item.inactive ? "Inactive note" : "Active balance"))}</p>
            </div>
            <div class="debt-balance-stack">
              <strong>${item.balance == null ? "Not entered" : money(item.balance)}</strong>
              ${
                projection
                  ? `<small>${money(projection.endingBalance)} after next payment</small>`
                  : isDebtItem(item) && item.balance != null
                    ? '<small class="rate-warning">Enter APR to project</small>'
                    : ""
              }
            </div>
          </div>
          <div class="debt-details">
            <span>Monthly<strong>${money(item.amount)}</strong></span>
            <span>Payer<strong>${escapeHtml(item.payer)}</strong></span>
            <span>APR<strong>${hasInterestRate(item) ? `${Number(item.interestRate).toFixed(2)}%` : "Not entered"}</strong></span>
            ${
              item.estimatedPayoffDate
                ? `<span>Est. payoff<strong>${new Date(
                    `${item.estimatedPayoffDate}T12:00:00`,
                  ).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}</strong></span>`
                : ""
            }
            ${
              projection
                ? `<span>Interest<strong>${money(projection.monthlyInterest)}</strong></span>
                   <span>Principal<strong>${money(projection.principalPaid)}</strong></span>`
                : ""
            }
            ${item.inactive ? "<span>Status<strong>Inactive</strong></span>" : ""}
          </div>
          <span class="debt-edit-hint">Edit debt <b aria-hidden="true">→</b></span>
        </article>`;
    })
    .join("");
}

function renderSettings() {
  $("#federalTaxRate").value = normalizeTaxRate(
    state.taxRates?.federal,
    DEFAULT_TAX_RATES.federal,
  );
  $("#californiaTaxRate").value = normalizeTaxRate(
    state.taxRates?.california,
    DEFAULT_TAX_RATES.california,
  );
  $("#selfEmploymentTaxRate").value = normalizeTaxRate(
    state.taxRates?.selfEmployment,
    DEFAULT_TAX_RATES.selfEmployment,
  );
  renderIncomeNeedPreview(state.taxRates);
}

function taxRatesFromForm() {
  return {
    federal: normalizeTaxRate($("#federalTaxRate").value),
    california: normalizeTaxRate($("#californiaTaxRate").value),
    selfEmployment: normalizeTaxRate($("#selfEmploymentTaxRate").value),
  };
}

function renderIncomeNeedPreview(rates) {
  const outflow = state.expenses.reduce((sum, item) => sum + item.amount, 0);
  const estimate = incomeNeedEstimate(outflow, rates);
  $("#monthlyExpensesNeed").textContent = money(outflow);
  $("#grossMonthlyIncomeNeed").textContent = money(estimate.monthlyGross);
  $("#grossAnnualIncomeNeed").textContent = money(estimate.annualGross);
  $("#combinedTaxRate").textContent = `${estimate.combinedRate.toFixed(1)}%`;
}

function populateSelects() {
  const options = categories
    .map((category) => `<option value="${category}">${category}</option>`)
    .join("");
  $("#expenseCategory").innerHTML = options;
  $("#categoryFilter").innerHTML =
    '<option value="All">All categories</option>' + options;
}

function showSection(section) {
  currentSection = section;
  $$(".page-section").forEach((element) => element.classList.add("hidden"));
  $(`#${section}Section`).classList.remove("hidden");
  $$(".nav-item").forEach((item) =>
    item.classList.toggle("active", item.dataset.section === section),
  );
  $("#sidebar").classList.remove("open");
  renderHeader();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openExpenseDialog(item = null) {
  $("#expenseForm").reset();
  $("#expenseId").value = item?.id || "";
  $("#dialogEyebrow").textContent = item ? "Update line item" : "New line item";
  $("#dialogTitle").textContent = item ? "Edit expense" : "Add expense";
  $("#expenseName").value = item?.name || "";
  $("#expenseCategory").value = item?.category || "Housing";
  $("#expensePayer").value = normalizePayer(item?.payer);
  $("#expenseAmount").value = item?.amount ?? "";
  $("#expenseBalance").value = item?.balance ?? "";
  $("#expenseInterestRate").value = item?.interestRate ?? "";
  $("#expensePayoffDate").value = item?.estimatedPayoffDate ?? "";
  $("#balanceEstimated").value = item?.balanceEstimated ? "true" : "false";
  $("#expenseNotes").value = item?.notes || "";
  $("#deleteDialogButton").classList.toggle("hidden", !item);
  updateDebtProjectionPreview();
  $("#expenseDialog").showModal();
}

function paymentForLoan(balance, annualRate, paymentCount) {
  const principal = Math.max(0, Number(balance) || 0);
  const months = Math.max(1, Number(paymentCount) || 1);
  const monthlyRate = Math.max(0, Number(annualRate) || 0) / 100 / 12;
  if (monthlyRate === 0) return principal / months;
  return (
    (principal * monthlyRate) /
    (1 - Math.pow(1 + monthlyRate, -months))
  );
}

function payoffMonthsForLoan(balance, payment, annualRate) {
  const principal = Math.max(0, Number(balance) || 0);
  const monthlyPayment = Math.max(0, Number(payment) || 0);
  const monthlyRate = Math.max(0, Number(annualRate) || 0) / 100 / 12;
  if (!principal || !monthlyPayment) return null;
  if (monthlyRate === 0) return Math.max(1, Math.ceil(principal / monthlyPayment));
  if (monthlyPayment <= principal * monthlyRate) return null;
  return Math.max(
    1,
    Math.ceil(
      -Math.log(1 - (monthlyRate * principal) / monthlyPayment) /
        Math.log(1 + monthlyRate),
    ),
  );
}

function annualRateForLoan(balance, payment, paymentCount) {
  const principal = Math.max(0, Number(balance) || 0);
  const monthlyPayment = Math.max(0, Number(payment) || 0);
  const months = Math.max(1, Number(paymentCount) || 1);
  if (!principal || !monthlyPayment) return null;
  const zeroRatePayment = principal / months;
  if (monthlyPayment < zeroRatePayment - 0.005) return null;
  if (Math.abs(monthlyPayment - zeroRatePayment) <= 0.005) return 0;

  let low = 0;
  let high = 100;
  while (paymentForLoan(principal, high, months) < monthlyPayment && high < 10000) {
    high *= 2;
  }
  if (paymentForLoan(principal, high, months) < monthlyPayment) return null;

  for (let index = 0; index < 80; index += 1) {
    const midpoint = (low + high) / 2;
    if (paymentForLoan(principal, midpoint, months) < monthlyPayment) {
      low = midpoint;
    } else {
      high = midpoint;
    }
  }
  return (low + high) / 2;
}

function payoffDateFromMonths(paymentCount) {
  const [year, month] = state.currentMonth.split("-").map(Number);
  const date = new Date(year, month - 1 + paymentCount, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function moveLoanCalculatorFields(isDebt) {
  const target = isDebt
    ? $("#loanCalculatorFields")
    : $("#standardPaymentFields");
  [
    $("#monthlyAmountField"),
    $("#balanceField"),
    $("#interestRateField"),
    $("#payoffDateField"),
  ].forEach((field) => {
    if (field.parentElement !== target) target.append(field);
  });
}

function updateDebtProjectionPreview({ message = "", isError = false } = {}) {
  const id = Number($("#expenseId").value);
  const existing = state.expenses.find((item) => item.id === id);
  const isDebt =
    $("#expenseCategory").value === "Debt payments" ||
    Boolean(existing?.isDebt);
  const balanceValue = $("#expenseBalance").value;
  const rateValue = $("#expenseInterestRate").value;
  const amountValue = $("#expenseAmount").value;

  moveLoanCalculatorFields(isDebt);
  $("#monthlyAmountLabel").textContent = isDebt
    ? "Monthly payment"
    : "Monthly amount";
  $("#interestRateField").classList.toggle("hidden", !isDebt);
  $("#payoffDateField").classList.toggle("hidden", !isDebt);
  $("#debtProjectionPreview").classList.toggle("hidden", !isDebt);
  const isEstimated = $("#balanceEstimated").value === "true";
  $("#balanceEstimateNote").classList.toggle("hidden", !isEstimated);
  if (isEstimated && !$("#balanceEstimateNote").textContent) {
    $("#balanceEstimateNote").textContent =
      "Calculated from the payment, APR, and payoff date.";
  }
  if (!isDebt) return;

  const warning = $("#projectionWarning");
  warning.textContent = message;
  warning.classList.toggle("hidden", !message);
  warning.classList.toggle("calculator-error", isError);

  const canProject =
    balanceValue !== "" && rateValue !== "" && amountValue !== "";
  $("#projectionGrid").classList.toggle("hidden", !canProject);
  if (!canProject) {
    $("#projectionGrid").innerHTML = "";
    return;
  }

  const payoffDate = $("#expensePayoffDate").value;
  const projection = debtProjection({
    balance: Number(balanceValue),
    amount: Number(amountValue),
    interestRate: Number(rateValue),
  });
  $("#projectionGrid").innerHTML = `
    <div><span>Current balance</span><strong>${money(projection.startingBalance)}</strong></div>
    <div><span>Monthly payment</span><strong>${money(projection.payment)}</strong></div>
    <div><span>Interest rate</span><strong>${projection.annualRate.toFixed(2)}%</strong></div>
    <div><span>Payoff date</span><strong>${payoffDate || "Not entered"}</strong></div>
    <div><span>First-month interest</span><strong>${money(projection.monthlyInterest)}</strong></div>
    <div class="projection-result"><span>Next balance</span><strong>${money(projection.endingBalance)}</strong></div>
  `;
}

function calculateLoanDetails() {
  const values = {
    balance:
      $("#expenseBalance").value === ""
        ? null
        : Number($("#expenseBalance").value),
    payment:
      $("#expenseAmount").value === "" ? null : Number($("#expenseAmount").value),
    rate:
      $("#expenseInterestRate").value === ""
        ? null
        : Number($("#expenseInterestRate").value),
    date: $("#expensePayoffDate").value || null,
  };
  const knownCount = Object.values(values).filter(
    (value) => value !== null,
  ).length;
  if (knownCount < 2) {
    updateDebtProjectionPreview({
      message: "Enter at least two values before calculating.",
      isError: true,
    });
    return;
  }

  const assumptions = [];
  if (knownCount === 2) {
    if (values.rate === null) {
      values.rate = 0;
      assumptions.push("0% APR");
    } else if (values.date === null) {
      values.date = payoffDateFromMonths(36);
      assumptions.push("a 36-month payoff period");
    } else if (values.balance === null && values.payment === null) {
      values.balance = 10000;
      assumptions.push("a $10,000 starting balance");
      $("#balanceEstimated").value = "true";
      $("#balanceEstimateNote").textContent =
        "Starting balance assumed by the Loan Calculator.";
    }
  }

  const paymentCount = values.date ? monthsUntilPayoff(values.date) : null;
  const missing = Object.entries(values)
    .filter(([, value]) => value === null)
    .map(([key]) => key);

  if (missing.length > 1) {
    updateDebtProjectionPreview({
      message: "Those values need one more input to produce an accurate result.",
      isError: true,
    });
    return;
  }

  const [missingValue] = missing;
  if (
    values.date &&
    paymentCount === null &&
    ["balance", "payment", "rate"].includes(missingValue)
  ) {
    updateDebtProjectionPreview({
      message: "Choose a payoff date after the current month.",
      isError: true,
    });
    return;
  }

  if (missingValue === "balance") {
    values.balance = estimateStartingBalance(
      values.payment,
      values.rate,
      paymentCount,
    );
    $("#balanceEstimated").value = "true";
    $("#balanceEstimateNote").textContent =
      "Balance generated by the Loan Calculator.";
  } else if (missingValue === "payment") {
    values.payment = paymentForLoan(
      values.balance,
      values.rate,
      paymentCount,
    );
  } else if (missingValue === "rate") {
    values.rate = annualRateForLoan(
      values.balance,
      values.payment,
      paymentCount,
    );
    if (values.rate === null) {
      updateDebtProjectionPreview({
        message:
          "The payment is too low for that balance and payoff date. Increase the payment or extend the date.",
        isError: true,
      });
      return;
    }
  } else if (missingValue === "date") {
    const months = payoffMonthsForLoan(
      values.balance,
      values.payment,
      values.rate,
    );
    if (months === null) {
      updateDebtProjectionPreview({
        message:
          "The payment does not cover the monthly interest. Increase the payment or lower the APR.",
        isError: true,
      });
      return;
    }
    values.date = payoffDateFromMonths(months);
  }

  $("#expenseBalance").value = Number(values.balance).toFixed(2);
  $("#expenseAmount").value = Number(values.payment).toFixed(2);
  $("#expenseInterestRate").value = Number(values.rate).toFixed(2);
  $("#expensePayoffDate").value = values.date;
  $("#balanceEstimateNote").classList.toggle(
    "hidden",
    $("#balanceEstimated").value !== "true",
  );

  const message = assumptions.length
    ? `Assumptions used: ${assumptions.join(" and ")}.`
    : missingValue
      ? `${missingValue.charAt(0).toUpperCase() + missingValue.slice(1)} calculated.`
      : "All four values are complete. Results refreshed.";
  updateDebtProjectionPreview({ message });
  showToast("Loan calculation complete");
}

function saveExpense(event) {
  event.preventDefault();
  const id = Number($("#expenseId").value);
  const existing = state.expenses.find((item) => item.id === id);
  const balanceValue = $("#expenseBalance").value;
  const interestRateValue = $("#expenseInterestRate").value;
  const estimatedPayoffDate = $("#expensePayoffDate").value;
  const category = $("#expenseCategory").value;
  const isDebt = category === "Debt payments" || Boolean(existing?.isDebt);
  const expense = {
    ...(existing || {}),
    id: id || Math.max(0, ...state.expenses.map((item) => item.id)) + 1,
    group: existing?.group || "Other Expenses",
    name: $("#expenseName").value.trim(),
    category,
    payer: $("#expensePayer").value,
    amount: Number($("#expenseAmount").value),
    balance: balanceValue === "" ? null : Number(balanceValue),
    interestRate:
      isDebt && interestRateValue !== "" ? Number(interestRateValue) : null,
    estimatedPayoffDate: isDebt ? estimatedPayoffDate : "",
    balanceEstimated: $("#balanceEstimated").value === "true",
    notes: $("#expenseNotes").value.trim(),
    isDebt,
  };

  if (!expense.name || Number.isNaN(expense.amount)) return;
  if (existing) {
    state.expenses = state.expenses.map((item) =>
      item.id === id ? expense : item,
    );
  } else {
    state.expenses.push(expense);
  }
  saveState();
  renderAll();
  $("#expenseDialog").close();
  showToast(existing ? "Expense updated" : "Expense added");
}

function deleteExpense(id) {
  const item = state.expenses.find((expense) => expense.id === id);
  if (!item || !window.confirm(`Delete “${item.name}” from the tracker?`)) return;
  state.expenses = state.expenses.filter((expense) => expense.id !== id);
  saveState();
  renderAll();
  showToast("Expense deleted");
}

function toggleMobileExpenseRow(row) {
  if (!window.matchMedia("(max-width: 650px)").matches) return;
  const willExpand = !row.classList.contains("mobile-expanded");
  $$(".expense-row.mobile-expanded").forEach((openRow) => {
    if (openRow !== row) {
      openRow.classList.remove("mobile-expanded");
      openRow.setAttribute("aria-expanded", "false");
    }
  });
  row.classList.toggle("mobile-expanded", willExpand);
  row.setAttribute("aria-expanded", String(willExpand));
}

function exportCsv() {
  const headers = [
    "Group",
    "Bill",
    "Category",
    "Payer",
    "Monthly Amount",
    "Balance",
    "Annual Interest Rate",
    "Estimated Payoff Date",
    "Balance Is Estimated",
    "Projected Balance After Payment",
    "Notes",
  ];
  const csvRows = [
    headers,
    ...state.expenses.map((item) => [
      item.group,
      item.name,
      item.category,
      item.payer,
      item.amount.toFixed(2),
      item.balance == null ? "" : item.balance.toFixed(2),
      hasInterestRate(item) ? Number(item.interestRate).toFixed(2) : "",
      item.estimatedPayoffDate || "",
      item.balanceEstimated ? "Yes" : "No",
      hasInterestRate(item) && item.balance != null
        ? debtProjection(item).endingBalance.toFixed(2)
        : "",
      item.notes,
    ]),
  ];
  const csv = csvRows
    .map((row) =>
      row
        .map((value) => `"${String(value).replaceAll('"', '""')}"`)
        .join(","),
    )
    .join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `homeledger-${state.currentMonth}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("CSV backup exported");
}

function openSyncDialog() {
  const status = cloudReady
    ? state.lastSyncedAt
      ? `Last cloud sync: ${new Date(state.lastSyncedAt).toLocaleString()}`
      : "Secure cloud sync is ready."
    : "Cloud sync is off. This ledger is saved on this device.";
  $("#syncStatus").textContent = status;
  $("#syncDialog").showModal();
}

function downloadSyncFile() {
  const timestamp = new Date().toISOString();
  state.lastSyncedAt = timestamp;
  saveState();

  const payload = {
    app: "HomeLedger",
    version: 1,
    exportedAt: timestamp,
    state,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `homeledger-sync-${state.currentMonth}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  $("#syncStatus").textContent =
    `Sync file downloaded ${new Date(timestamp).toLocaleString()}.`;
  showToast("Sync file downloaded");
}

async function importSyncFile(event) {
  const [file] = event.target.files;
  if (!file) return;

  try {
    const payload = JSON.parse(await file.text());
    const importedState = payload.state || payload;
    if (!Array.isArray(importedState.expenses)) {
      throw new Error("Missing expenses data");
    }
    state = normalizeState(importedState);
    state.lastSyncedAt = new Date().toISOString();
    saveState();
    renderAll();
    $("#syncStatus").textContent =
      `Sync file imported ${new Date(state.lastSyncedAt).toLocaleString()}.`;
    showToast("Device data synced");
  } catch (error) {
    console.warn("Could not import HomeLedger sync data.", error);
    $("#syncStatus").textContent =
      "That file is not a valid HomeLedger sync file.";
  } finally {
    event.target.value = "";
  }
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 2400);
}

function setTextSizeLevel(level, { persist = true } = {}) {
  const normalizedLevel = ["regular", "large", "extra"].includes(level)
    ? level
    : "regular";
  document.documentElement.classList.toggle(
    "magnified-text",
    normalizedLevel === "large",
  );
  document.documentElement.classList.toggle(
    "extra-magnified-text",
    normalizedLevel === "extra",
  );

  const labels = {
    regular: {
      action: "Turn on larger text",
      button: "Larger text",
    },
    large: {
      action: "Turn on extra-large text",
      button: "Extra-large text",
    },
    extra: {
      action: "Return to standard text",
      button: "Standard text",
    },
  };

  $$("[data-text-size-toggle]").forEach((button) => {
    button.setAttribute("aria-pressed", String(normalizedLevel !== "regular"));
    button.setAttribute("aria-label", labels[normalizedLevel].action);
    const label = button.querySelector("[data-text-size-label]");
    if (label) label.textContent = labels[normalizedLevel].button;
  });
  if (persist) localStorage.setItem(TEXT_SIZE_KEY, normalizedLevel);
}

function openLocalApp() {
  const remembered = (localStorage.getItem(REMEMBERED_USERNAME_KEY) || "")
    .trim()
    .toLowerCase();
  activeUser = AUTH_PROFILES[remembered] || activeUser || "Tyrone";
  currentAuthUser = null;
  cloudReady = false;
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  renderAll();
}

async function openAuthenticatedApp(user, profileName) {
  if (!["Tyrone", "Pamela"].includes(profileName)) {
    await supabaseClient.auth.signOut();
    throw new Error("This account is not assigned to the HomeLedger household.");
  }

  currentAuthUser = user;
  activeUser = profileName;
  await loadHouseholdState();
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  renderAll();
}

async function signIn(username, password) {
  const normalizedUsername = username.trim().toLowerCase();
  if (!AUTH_PROFILES[normalizedUsername]) {
    throw new Error("Username or password does not match a family profile.");
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/username-login`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username: normalizedUsername, password }),
  });
  const authData = await response.json();
  if (
    !response.ok ||
    !authData.access_token ||
    !authData.refresh_token ||
    !authData.homeledger_profile
  ) {
    throw new Error("Username or password does not match a family profile.");
  }
  const {
    data: { session },
    error,
  } = await supabaseClient.auth.setSession({
    access_token: authData.access_token,
    refresh_token: authData.refresh_token,
  });
  if (error || !session?.user) {
    throw new Error("Secure session could not be created.");
  }
  localStorage.setItem(AUTH_PROFILE_KEY, authData.homeledger_profile);

  if ($("#rememberUsername").checked) {
    localStorage.setItem(
      REMEMBERED_USERNAME_KEY,
      normalizedUsername.toUpperCase(),
    );
  } else {
    localStorage.removeItem(REMEMBERED_USERNAME_KEY);
  }

  try {
    await openAuthenticatedApp(session.user, authData.homeledger_profile);
  } catch (cloudError) {
    await supabaseClient.auth.signOut();
    currentAuthUser = null;
    activeUser = null;
    cloudReady = false;
    throw cloudError;
  }
}

async function signOut() {
  clearTimeout(cloudSaveTimer);
  cloudReady = false;
  currentAuthUser = null;
  activeUser = null;
  localStorage.removeItem(AUTH_PROFILE_KEY);
  await supabaseClient.auth.signOut();
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  $("#username").value =
    localStorage.getItem(REMEMBERED_USERNAME_KEY) || "";
  $("#password").value = "";
}

function bindEvents() {
  $("#openLocalButton").addEventListener("click", () => openLocalApp());
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = $("#loginSubmitButton");
    submitButton.disabled = true;
    submitButton.querySelector("span").textContent = "Signing in…";
    $("#loginError").textContent = "";

    try {
      await signIn($("#username").value, $("#password").value);
      $("#password").value = "";
    } catch (error) {
      console.warn("HomeLedger sign-in failed.", error);
      $("#loginError").textContent = error.message;
    } finally {
      submitButton.disabled = false;
      submitButton.querySelector("span").textContent = "Sign in";
    }
  });

  $("#showPassword").addEventListener("click", () => {
    const input = $("#password");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("#showPassword").textContent = showing ? "Show" : "Hide";
  });

  $$("[data-text-size-toggle]").forEach((button) =>
    button.addEventListener("click", () => {
      const root = document.documentElement;
      const nextLevel = root.classList.contains("extra-magnified-text")
        ? "regular"
        : root.classList.contains("magnified-text")
          ? "extra"
          : "large";
      setTextSizeLevel(nextLevel);
      const messages = {
        regular: "Standard text restored",
        large: "Larger text turned on",
        extra: "Extra-large text turned on",
      };
      showToast(messages[nextLevel]);
    }),
  );

  $$(".nav-item").forEach((item) =>
    item.addEventListener("click", () => showSection(item.dataset.section)),
  );
  $$("[data-goto]").forEach((item) =>
    item.addEventListener("click", () => showSection(item.dataset.goto)),
  );

  $("#menuButton").addEventListener("click", () =>
    $("#sidebar").classList.toggle("open"),
  );
  $("#profileButton").addEventListener("click", () => {
    if (window.confirm("Sign out of HomeLedger?")) signOut();
  });
  $("#settingsSignOutButton").addEventListener("click", () => {
    if (window.confirm("Sign out of HomeLedger?")) signOut();
  });

  $("#addExpenseButton").addEventListener("click", () => openExpenseDialog());
  $("#closeExpenseDialog").addEventListener("click", () =>
    $("#expenseDialog").close(),
  );
  $("#cancelDialog").addEventListener("click", () =>
    $("#expenseDialog").close(),
  );
  $("#expenseForm").addEventListener("submit", saveExpense);
  $("#expenseCategory").addEventListener("change", () => {
    updateDebtProjectionPreview();
  });
  ["expenseAmount", "expenseInterestRate", "expensePayoffDate"].forEach((id) =>
    $(`#${id}`).addEventListener("input", () => {
      updateDebtProjectionPreview();
    }),
  );
  $("#expenseBalance").addEventListener("input", () => {
    $("#balanceEstimated").value = "false";
    $("#balanceEstimateNote").textContent = "";
    $("#balanceEstimateNote").classList.add("hidden");
    updateDebtProjectionPreview();
  });
  $("#calculateLoanButton").addEventListener("click", calculateLoanDetails);
  $("#deleteDialogButton").addEventListener("click", () => {
    const id = Number($("#expenseId").value);
    deleteExpense(id);
    if (!state.expenses.some((item) => item.id === id)) {
      $("#expenseDialog").close();
    }
  });

  $("#expenseTableBody").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit]");
    if (editButton) {
      const item = state.expenses.find(
        (expense) => expense.id === Number(editButton.dataset.edit),
      );
      openExpenseDialog(item);
      return;
    }
    const row = event.target.closest(".expense-row");
    if (row) toggleMobileExpenseRow(row);
  });
  $("#expenseTableBody").addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key) || event.target.closest("button")) {
      return;
    }
    const row = event.target.closest(".expense-row");
    if (!row) return;
    event.preventDefault();
    toggleMobileExpenseRow(row);
  });

  $("#debtList").addEventListener("click", (event) => {
    const card = event.target.closest("[data-debt-edit]");
    if (!card) return;
    const item = state.expenses.find(
      (expense) => expense.id === Number(card.dataset.debtEdit),
    );
    if (item) openExpenseDialog(item);
  });
  $("#debtList").addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const card = event.target.closest("[data-debt-edit]");
    if (!card) return;
    event.preventDefault();
    const item = state.expenses.find(
      (expense) => expense.id === Number(card.dataset.debtEdit),
    );
    if (item) openExpenseDialog(item);
  });

  ["expenseSearch", "categoryFilter", "payerFilter"].forEach((id) =>
    $(`#${id}`).addEventListener("input", renderExpenseTable),
  );

  $("#incomeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const rates = taxRatesFromForm();
    const combinedRate =
      rates.federal + rates.california + rates.selfEmployment;
    if (combinedRate >= 100) {
      showToast("Combined tax rate must be below 100%");
      return;
    }
    state.taxRates = rates;
    saveState();
    renderAll();
    showToast("Tax rates and income need updated");
  });
  ["federalTaxRate", "californiaTaxRate", "selfEmploymentTaxRate"].forEach(
    (id) =>
      $(`#${id}`).addEventListener("input", () =>
        renderIncomeNeedPreview(taxRatesFromForm()),
      ),
  );

  $("#exportButton").addEventListener("click", exportCsv);
  $("#settingsExportButton").addEventListener("click", exportCsv);
  $("#syncButton").addEventListener("click", openSyncDialog);
  $("#closeSyncDialog").addEventListener("click", () =>
    $("#syncDialog").close(),
  );
  $("#downloadSyncButton").addEventListener("click", downloadSyncFile);
  $("#syncNowButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      clearTimeout(cloudSaveTimer);
      await pushHouseholdState({ showConfirmation: true });
    } catch (error) {
      console.warn("Manual cloud sync failed.", error);
      $("#syncStatus").textContent =
        "Cloud sync failed. Check your connection and try again.";
    } finally {
      button.disabled = false;
    }
  });
  $("#importSyncButton").addEventListener("click", () =>
    $("#syncFileInput").click(),
  );
  $("#syncFileInput").addEventListener("change", importSyncFile);
}

async function init() {
  const savedTextSize = localStorage.getItem(TEXT_SIZE_KEY);
  setTextSizeLevel(
    savedTextSize === "true" ? "large" : savedTextSize || "regular",
    {
      persist: false,
    },
  );
  populateSelects();
  bindEvents();
  const rememberedUsername = localStorage.getItem(REMEMBERED_USERNAME_KEY);
  if (rememberedUsername) {
    $("#username").value = rememberedUsername;
    $("#rememberUsername").checked = true;
  }
  state.currentMonth = currentMonthValue();
  saveState({ syncCloud: false });
  window.setInterval(() => {
    const currentMonth = currentMonthValue();
    if (state.currentMonth !== currentMonth) {
      state.currentMonth = currentMonth;
      saveState();
      renderAll();
    }
  }, 60 * 60 * 1000);
  renderAll();
  scheduleDailyAffirmation();
  openLocalApp();
}

init().catch((error) => {
  console.error("HomeLedger could not start.", error);
  $("#loginError").textContent =
    "HomeLedger could not connect securely. Check your internet connection.";
});
