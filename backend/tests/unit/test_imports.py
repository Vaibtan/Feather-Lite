from app.main import app
from app.models import Base
from app.voice.agent_runtime import server


def test_app_bootstrap_imports() -> None:
    assert app is not None
    assert Base.metadata.tables
    assert server is not None
