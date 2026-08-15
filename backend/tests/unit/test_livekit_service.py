from uuid import uuid4

from app.services.livekit_service import build_room_name, extract_conversation_id, parse_room_metadata


def test_parse_room_metadata_handles_invalid_json() -> None:
    assert parse_room_metadata("not-json") == {}


def test_extract_conversation_id_prefers_room_metadata() -> None:
    conversation_id = uuid4()
    found = extract_conversation_id(f'{{"conversation_id":"{conversation_id}"}}', None)
    assert found == conversation_id


def test_extract_conversation_id_falls_back_to_room_name() -> None:
    conversation_id = uuid4()
    room_name = build_room_name(conversation_id)
    found = extract_conversation_id(None, room_name)
    assert found == conversation_id
