// cost-budget.bicep — Subscription-scope Cost Management budget.
// ADR-0017 §Decision.8 item 1: defence-in-depth on the Azure-billing plane
// for LLM-token runaways that bypass the in-orchestrator token budget
// (ADR-0019). The in-orchestrator budget bounds tokens per agent per day;
// this budget bounds currency per subscription per month.
//
// Currency caveat: `Microsoft.Consumption/budgets` is denominated in the
// billing account's currency. The ADR default amounts (£25/mo dev,
// £100/mo prod) assume a GBP billing account. For a USD/EUR account the
// numeric default still deploys but is interpreted in that currency — the
// deployer should override `budgetAmount` to the currency equivalent per
// their billing context. Documented, not enforced in Bicep.
//
// Notifications: email-only to `adminEmail` at 50 / 80 / 100% thresholds.
// If the action group resource ID is supplied, the 100% threshold ALSO
// fires it — which a future Logic App (post-MVP) can pick up for the
// optional auto-disable action ADR-0017 §Decision.8 item 1 references.
// `autoDisableOnBudgetBreach` is the operator-facing knob gating that
// wiring; false = notify-only, true = notify + (future) auto-disable.

targetScope = 'subscription'

@description('Workload token. Used in the budget name and category.')
param workload string = 'aegis'

@description('Environment token.')
param environment string

@minValue(1)
@maxValue(100000)
@description('Monthly budget amount in the billing account currency. ADR-0017 §Decision.8 item 1 defaults: 25 (dev), 100 (prod). Override via `azd env set AZURE_FOUNDRY_BUDGET_GBP=<value>` when the billing currency is not GBP.')
param budgetAmount int = 25

@description('Budget start date in yyyy-MM-dd. Must be the first of a month; Azure truncates the day to 01 regardless.')
param startDate string

@description('Admin email for cost notifications.')
param adminEmail string

@description('Optional ActionGroup resource ID. When supplied, fires at the 100% threshold in addition to email. Leave empty to disable.')
param actionGroupResourceId string = ''

@description('Opt-in to the future Logic App auto-disable action on 100% breach (ADR-0017 §Decision.8 item 1). MVP behaviour: notify-only. When the Logic App module lands, this toggle gates its deployment + action-group subscription.')
#disable-next-line no-unused-params
param autoDisableOnBudgetBreach bool = false

var budgetName = '${workload}-monthly-${environment}'

var notification50 = {
  enabled: true
  operator: 'GreaterThan'
  threshold: 50
  contactEmails: [
    adminEmail
  ]
  thresholdType: 'Actual'
}

var notification80 = {
  enabled: true
  operator: 'GreaterThan'
  threshold: 80
  contactEmails: [
    adminEmail
  ]
  thresholdType: 'Actual'
}

var notification100 = empty(actionGroupResourceId) ? {
  enabled: true
  operator: 'GreaterThan'
  threshold: 100
  contactEmails: [
    adminEmail
  ]
  thresholdType: 'Actual'
} : {
  enabled: true
  operator: 'GreaterThan'
  threshold: 100
  contactEmails: [
    adminEmail
  ]
  contactGroups: [
    actionGroupResourceId
  ]
  thresholdType: 'Actual'
}

resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: budgetName
  properties: {
    amount: budgetAmount
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    notifications: {
      threshold50: notification50
      threshold80: notification80
      threshold100: notification100
    }
  }
}

output budgetId string = budget.id
output budgetName string = budget.name
