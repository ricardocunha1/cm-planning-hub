"""QA end-to-end (marker `db`): what the client's Settings modal and ADO pickers do, against the
real app with authentication enabled and a real PostgreSQL. A project saved in Settings with a messy
URL is listed in canonical form; the picker then connects / syncs with that canonical URL and no
`pat`, and the server resolves the signed-in user's saved PAT (never anyone else's, never after a
delete). Mirrors client/src/AdoSettingsFullStack.integration.test.tsx."""
import pytest

from ado_fakes import PROJECT_NAME
from test_multiuser_integration import CRED_URL, PAT_A, PAT_B, basic, save_pat, stack, users  # noqa: F401  (fixtures)

pytestmark = pytest.mark.db

MESSY = "https://DEV.azure.com/contoso/Fabrikam Plant/"
CANONICAL = "https://dev.azure.com/contoso/Fabrikam%20Plant"


def test_settings_list_is_canonical_masked_and_drives_a_pat_less_connect_and_sync(users):  # noqa: F811
    ana, ben, fake, _ = users
    created = save_pat(ana, PAT_A, url=MESSY, name="Fabrikam")
    assert created["projectUrl"] == CANONICAL
    assert created["hasPat"] is True and created["patLast4"] == PAT_A[-4:]
    listed = ana.get(CRED_URL)
    assert listed.json()["items"] == [created]
    assert PAT_A not in listed.text and PAT_A not in str(created)
    assert ben.get(CRED_URL).json() == {"items": []}

    # Picker: Connect sends the listed URL, the inferred source and no pat.
    connect = ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": CANONICAL})
    assert connect.status_code == 200, connect.text
    # Sync dialog: backlog with the plan's connection (canonical URL from the connect response), no pat.
    backlog = ana.post(
        "/api/ado/backlog",
        json={"source": "cloud", "projectUrl": connect.json()["projectUrl"], "scopeType": "area", "scopePath": f"{PROJECT_NAME}\\Team A"},
    )
    assert backlog.status_code == 200, backlog.text
    assert fake.requests and all(q.headers["Authorization"] == basic(PAT_A) for q in fake.requests)
    assert PAT_A not in connect.text and PAT_A not in backlog.text

    # Another user never borrows it.
    fake.requests.clear()
    assert ben.post("/api/ado/connect", json={"source": "cloud", "projectUrl": CANONICAL}).status_code == 422
    assert fake.requests == []


def test_deleting_the_project_in_settings_makes_the_pat_less_requests_fail_cleanly(users):  # noqa: F811
    ana, _, fake, _ = users
    created = save_pat(ana, PAT_A, url=MESSY)
    assert ana.delete(f"{CRED_URL}/{created['id']}").status_code == 204
    fake.requests.clear()
    body = {"source": "cloud", "projectUrl": CANONICAL}
    for path, extra in (
        ("/api/ado/connect", {}),
        ("/api/ado/backlog", {"scopeType": "area", "scopePath": "P"}),
        ("/api/ado/sprint-history", {"iterationPath": "P"}),
    ):
        r = ana.post(path, json={**body, **extra})
        assert r.status_code == 422, (path, r.text)
        assert set(r.json()) == {"errors"} and "Personal Access Token is required" in r.json()["errors"][0]
    assert fake.requests == []


def test_a_port_or_other_host_form_is_a_different_project_so_the_client_match_must_agree(users):  # noqa: F811
    ana, _, fake, _ = users
    save_pat(ana, PAT_A, url=CANONICAL)
    # Trailing slash and case resolve to the saved project...
    for url in (CANONICAL + "/", CANONICAL.upper().replace("HTTPS", "https"), CANONICAL.replace("Fabrikam%20Plant", "fabrikam%20plant")):
        assert ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": url}).status_code == 200, url
    # ...an explicit port is another project (the client's sameProjectUrl treats it as different too).
    fake.requests.clear()
    r = ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": CANONICAL.replace("dev.azure.com", "dev.azure.com:8443")})
    assert r.status_code == 422 and fake.requests == []


def test_editing_a_saved_project_keeps_the_pat_only_for_the_same_canonical_url(users):  # noqa: F811
    ana, _, fake, _ = users
    created = save_pat(ana, PAT_A, url=CANONICAL, name="Old name")
    same = ana.put(f"{CRED_URL}/{created['id']}", json={"projectName": "New name", "projectUrl": CANONICAL.upper().replace("HTTPS", "https")})
    assert same.status_code == 200, same.text
    assert same.json()["patLast4"] == PAT_A[-4:]
    moved = ana.put(f"{CRED_URL}/{created['id']}", json={"projectName": "New name", "projectUrl": "https://dev.azure.com/contoso/Other"})
    assert moved.status_code == 422 and set(moved.json()) == {"errors"}
    ok = ana.put(f"{CRED_URL}/{created['id']}", json={"projectName": "New name", "projectUrl": "https://dev.azure.com/contoso/Other", "pat": PAT_B})
    assert ok.status_code == 200 and ok.json()["patLast4"] == PAT_B[-4:]
    fake.requests.clear()
    # The fake Azure DevOps only knows "Fabrikam Plant": the new PAT is nonetheless the one sent for the new URL.
    ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": "https://dev.azure.com/contoso/Other"})
    assert fake.requests and all(q.headers["Authorization"] == basic(PAT_B) for q in fake.requests)
