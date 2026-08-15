from functools import lru_cache

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "Feather-Lite Backend"
    app_version: str = "0.1.0"
    environment: str = "local"
    debug: bool = True
    reload: bool = False
    host: str = "127.0.0.1"
    port: int = 8000

    database_url: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/feather_lite"
    )
    sqlalchemy_echo: bool = False
    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = None
    livekit_agent_name: str = "feather-lite-agent"
    livekit_room_prefix: str = "feather-lite"
    livekit_room_empty_timeout: int = 300
    livekit_stt_model: str = "deepgram/nova-3:en"
    livekit_tts_model: str = "cartesia/sonic-3:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def sync_database_url(self) -> str:
        if self.database_url.startswith("postgresql+asyncpg://"):
            return self.database_url.replace(
                "postgresql+asyncpg://",
                "postgresql+psycopg://",
                1,
            )
        return self.database_url

    @computed_field  # type: ignore[prop-decorator]
    @property
    def livekit_configured(self) -> bool:
        return bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()
