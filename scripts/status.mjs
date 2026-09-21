import {
  closeAllSessions,
  getRouterSettings,
  refreshInventory,
  summarizeUnavailableServers,
} from '../src/router-core.mjs';

try {
  const settings = getRouterSettings();
  const inventory = await refreshInventory({ force: true });
  const counts = {};
  for (const tool of inventory.tools) {
    counts[tool.server] = (counts[tool.server] ?? 0) + 1;
  }

  console.log(
    JSON.stringify(
      {
        model: settings.model,
        threshold: settings.threshold,
        fallbackCandidateLimit: settings.fallbackCandidateLimit,
        jevStateQuestionBudgetTokens:
          settings.jevStateQuestionBudgetTokens,
        jevTotalBudgetTokens: settings.jevTotalBudgetTokens,
        jevContextBudgetTokens: settings.jevContextBudgetTokens,
        configPath: settings.configPath,
        routedToolCount: inventory.tools.length,
        toolsByServer: counts,
        unavailableServers: summarizeUnavailableServers(inventory.errors),
      },
      null,
      2,
    ),
  );
} finally {
  await closeAllSessions();
}
