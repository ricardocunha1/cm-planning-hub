# Planning Hub — Release Plan

> **Note (2026-11-03):** the JSON import/export requirements below (creating a
> board from a JSON file, the JSON import/export option and the JSON card on
> the entry page) are **superseded by `specs/release_plan_persistence`**.
> Boards are now created from Azure DevOps only and stored in the database.
> PNG export and everything else still apply.

This application will create interactive drag-and-drop boards to create release plans, based on the backlog of selectable CM Projects.

## Requirements

- User must create a new board by importing data from two sources:
    - Azure DevOps (define the project, and one of area path/iteration path)
    - Previously exported JSON file from a previous board.
- Users can then drag and drop items on the board to plan releases.
- The board must have an option to import/export to JSON and export as a PNG image (just the board).

## Template

The board must be based on the functionality implemented by `templates/features-release-board-example` and `template/feature_release_plan_2026-10-20.json`.

## Usability

After adding the Release Plan app inside CM Planning Hub, user must be able to select one of two cards:
1. Create a new board by importing data from Azure DevOps.
2. Create a new board by importing a previously exported JSON file.

For 1., after the user clicks the card, a modal page opens where the user needs to:
    - Select the AzureDevOps source - "On-Prem" or "Collaboration Hub" (online). Changing the source clears the project URL so the new source's placeholder shows (the PAT is kept).
    - Select the AzureDevOps project URL (for example `https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/<PROJECT_NAME>` (On Prem) or `https://dev.azure.com/<ORGANIZATION_ID>/<PROJECT_NAME>` (Collaboration Hub))
    - Enter a PAT Token (Personal Access Token) for authentication.
    - After URL and Token are validated, the user can proceed to select either an   area path or an iteration path. One of the two MUST be selected.
- Select either an area path or an iteration path.

For 2., after the user clicks the card, a modal page opens where the user needs to select the JSON file. The selected JSON file will be used to create a new board with the previously saved release plan.

After the data is imported, the board will be displayed and it must work exactly the same way as in the template.


## Implementation Phases

- **Phase 0:** Set up the first page of the app with the card selection. Selection of Azure DevOps must now be disabled (temporarily).
- **Phase 1:** Implement board creation by importing a JSON file.
- **Phase 2:** Enable drag-and-drop functionality.
- **Phase 3:** Implement import/export to JSON and export as PNG image.
- **Phase 4:** Implement board creation by setting up a connection to Azure DevOps (described above).
- **Phase 5:** Synchronize data from AzureDevOps (e.g., create missing features, update features status).

## Common Notes

- Follow React best practices for component structure and state management. Retain only the functionality but organize the components in a modular and maintainable way.
- For automatic testing, you can generate files similar to the json referenced in this file, but do not use it since it will not be committed into the repository.
