from openai import AsyncOpenAI

from core.config import settings


_client: AsyncOpenAI | None = None


def _openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


async def embed(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    response = await _openai().embeddings.create(
        model=settings.embedding_model,
        input=texts,
    )
    return [item.embedding for item in response.data]


async def embed_one(text: str) -> list[float]:
    vectors = await embed([text])
    return vectors[0]


def element_text(tag: str, xpath: str, aria_label: str | None, text: str) -> str:
    # xpath는 의미가 없어 임베딩 입력에서 제외. 시그니처는 호환을 위해 유지.
    parts: list[str] = []
    if aria_label:
        parts.append(aria_label)
    if text:
        parts.append(text)
    return f"{tag}: {' '.join(parts)}" if parts else tag
