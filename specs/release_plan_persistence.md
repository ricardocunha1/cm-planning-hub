# Planning Hub - Release Plan Persistence

This document outlines how release plans are to be persisted and should be managed within the system.

## Functional Requirements

1. When opening the Release Plan page, besides the current creation options, the user must see a list of previously created and stored release plans.
    - The list must be paginated (10 plans per page), ordered by last modified date
    - The user must be able to navigate between pages.
    - For each release plan, there must be a name, creation date, last modified date, which project is connected to (on prem / collaboration hub and the name of the project)
    - When the user selects the release plan, the board for that release plan opens, with the state that will be stored in the database.
    - The user must be able to delete a release plan from the list, with a confirmation prompt before deletion.
    - There must be an autosave option that saves the state of the release plan a few seconds after any change is made. Autosave can enabled and disabled inside the board. If autosave is disabled, a button to save the release board must be available.
    - The options to save and load JSON files options must be discontinued.

## Technical Requirements

1. Create a PostgreSQL database to store the release plans
    - For now, add postgres as an image to docker compose and the helm charts, with no configurable volumes
    - Table `release_plans`
        - id (primary key serial)
        - name (text not null)
        - created_at (timestamp not null default now())
        - updated_at (timestamp not null default now())
        - project_type (text not null) # On Prem / Collaboration Hub
        - project_name (text not null)
        - state (jsonb not null) # Stores the current state of the release plan board

2. Change the API to implement the following endpoints. Create a specific router for release plans.
    - `GET /plan` - Retrieves a paginated list of release plans, ordered by last modified date (updated_at)
    - `GET /plan/{id}` - Retrieves the details of a specific release plan, by its ID, including the state. Called when we need to load a release plan into the board.
    - `POST /plan` - Creates a new release plan with the provided details and initial state.
    - `PUT /plan/{id}` - Updates an existing release plan by its ID, including changes to the state.
    - `DELETE /plan/{id}` - Deletes a specific release plan by its ID.

3. Implement the backend logic to handle the release plan persistence.
    - When creating a new release plan, insert a new row into the `release_plans` table with the provided details and initial state.
    - When updating a release plan, update the corresponding row in the `release_plans` table, including the `updated_at` timestamp.
    - When deleting a release plan, remove the corresponding row from the `release_plans` table.
    - When retrieving a list of release plans, query the `release_plans` table with pagination and ordering by `updated_at`.
    - When retrieving a specific release plan, query the `release_plans` table by its ID and return the details, including the state.

4. Implement the frontend logic to interact with the release plan API.
    - When the user selects a release plan from the list, send a `GET /plan/{id}` request to load the release plan into the board.
    - When the user makes changes to the release plan, either autosave the changes by sending a `PUT /plan/{id}` request or allow the user to manually save the changes.
    - When the user deletes a release plan, send a `DELETE /plan/{id}` request and update the list of release plans accordingly.
    - When creating a new release plan, send a `POST /plan` request with the initial details and state, and update the list of release plans with the newly created plan.
        - Add a new option in the modal page to enter the name of the plan.
