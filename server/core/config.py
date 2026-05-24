from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 1536
    chat_model: str = "gpt-4o-mini"

    qdrant_url: str = "http://qdrant:6333"
    qdrant_collection: str = "dom_elements"

    neo4j_uri: str = "bolt://neo4j:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "password"

    postgres_dsn: str = "postgresql://eeum:eeum@postgres:5432/eeum"

    session_ttl_seconds: int = 60 * 60 * 24 * 7


settings = Settings()
