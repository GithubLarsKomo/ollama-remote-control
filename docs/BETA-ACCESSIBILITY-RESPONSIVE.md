# 0.1 beta accessibility and responsive scope

This document records the bounded accessibility and responsive hardening performed for the 0.1 beta. It is release evidence for issue #141; it is **not** a claim of full WCAG conformance or a substitute for assistive-technology testing by users.

## Surfaces reviewed

The production surfaces present in the amended 0.1 beta were reviewed at the component and style level: authentication/bootstrap, dashboard and target selection, Audit, Models, Modelfiles, model details, logs, container lifecycle, update and manual rollback. Expert Mode and model deletion are outside the amended 0.1-beta scope.

The review checks semantic landmarks/headings already present in the React components, nested or otherwise programmatically labelled form controls, explicit `role="alert"`/`role="status"` use for failures and progress, keyboard-reachable native controls, and concrete text in confirmation/warning flows so state is not communicated by color alone.

## Automated regression scope

The existing Vitest stack now guards the following bounded invariants without adding a browser or accessibility dependency:

- visible `:focus-visible` treatment for buttons, inputs, selects, textareas, links, disclosure summaries, model-detail tabs and destructive-action buttons;
- labelled Models/Modelfiles administration navigation with an explicit current-page state;
- labelled Audit landmark plus live loading/pagination status;
- narrow-layout rules for the dashboard, Audit pagination, Models/Modelfiles navigation, model-detail tabs, update and rollback controls;
- local overflow containment for tables, preformatted/raw content, long links, model names, digests and other evidence strings;
- reduced-motion handling already present for global transitions and update progress animation.

These are structural/style regression checks. They intentionally do not claim to run a full accessibility engine or emulate a screen reader.

## Representative responsive targets

The CSS contract is designed and reviewed around these representative widths:

- **320 px**: minimum supported narrow viewport; single-column dashboard/forms/actions, locally scrollable table/raw-content regions;
- **390 px**: common phone-width check for navigation, Audit pagination, Models/Modelfiles controls and confirmations;
- **768 px**: tablet/narrow desktop transition; dashboard and update layouts remain usable without hiding required evidence;
- **1280 px and above**: normal desktop layout.

Required actions are not intentionally hidden at narrow widths. Wide evidence tables may scroll inside their own bounded wrapper rather than forcing page-level horizontal overflow.

## Keyboard and confirmation behavior

Normal administration uses native buttons, inputs, selects, checkboxes, links and `details/summary`; no beta action requires hover or pointer-only interaction. Focus visibility is explicitly styled. Update and rollback confirmation content remains in DOM reading/tab order and includes textual target/boundary warnings in addition to status colors.

## Forced colors and motion

The supplemental beta stylesheet leaves key buttons/status controls available to the user agent in forced-colors mode. Existing reduced-motion rules suppress most transition motion and slow the update spinner.

## Residual manual checks before public beta

The following remain manual release checks and should not be represented as automated evidence:

1. Keyboard-only walkthrough in a current Chromium- and Firefox-family desktop browser, including backwards tab order.
2. Browser zoom at 200% and 400% on the primary administration surfaces.
3. Real viewport checks at approximately 320/390/768 px, including long model names, digests and source URLs.
4. At least one screen-reader smoke pass for login, target selection, Models/Modelfiles navigation, Audit filtering and update/rollback confirmation.
5. Windows High Contrast or another forced-colors environment.
6. Verify focus remains understandable after asynchronous state changes, validation failures and completed mutations.

Any material failure from these manual checks remains a beta blocker until fixed or explicitly documented with severity and scope.
