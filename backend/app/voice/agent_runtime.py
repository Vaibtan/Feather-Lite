from __future__ import annotations

import logging
from uuid import UUID

from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobProcess, StopResponse, cli
from livekit.plugins import silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from app.core.config import get_settings
from app.core.enums import EventType
from app.core.db import AsyncSessionFactory
from app.core.errors import NotFoundError, ValidationError
from app.models import Conversation
from app.services.conversation_store import get_conversation_with_related
from app.services.livekit_service import extract_conversation_id
from app.services.workflow_service import INITIAL_GREETING
from app.voice.livekit_adapter import process_voice_turn

load_dotenv()

logger = logging.getLogger("feather_lite.voice")
settings = get_settings()
server = AgentServer()


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


class FeatherVoiceAgent(Agent):
    def __init__(self, conversation_id: UUID) -> None:
        super().__init__(
            instructions=(
                "You are the Feather-Lite voice runtime. "
                "Do not generate independent business logic. "
                "Your spoken replies are supplied by the backend orchestrator."
            )
        )
        self._conversation_id = conversation_id

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:  # type: ignore[override]
        user_text = (new_message.text_content or "").strip()

        try:
            async with AsyncSessionFactory() as session:
                adapter_result = await process_voice_turn(session, self._conversation_id, user_text)
        except (NotFoundError, ValidationError) as exc:
            logger.warning("voice turn rejected: %s", exc)
            handle = self.session.say(
                "This conversation is no longer active. Goodbye.",
                allow_interruptions=False,
            )
            await handle.wait_for_playout()
            await self.session.aclose()
            raise StopResponse() from exc

        handle = self.session.say(
            adapter_result.spoken_text,
            allow_interruptions=adapter_result.allow_interruptions,
        )
        if adapter_result.should_end_call:
            try:
                await handle.wait_for_playout()
            finally:
                await self.session.aclose()

        raise StopResponse()


@server.rtc_session(agent_name=settings.livekit_agent_name)
async def feather_voice_entrypoint(ctx: JobContext) -> None:
    conversation_id = extract_conversation_id(
        getattr(ctx.room, "metadata", None),
        getattr(ctx.room, "name", None),
    )
    if conversation_id is None:
        raise ValidationError("LiveKit room metadata is missing a valid conversation_id")

    async with AsyncSessionFactory() as session:
        conversation = await get_conversation_with_related(session, conversation_id)
        if conversation.final_outcome is not None:
            logger.warning("conversation %s already completed before voice session start", conversation_id)
            return

    agent_session = AgentSession(
        stt=settings.livekit_stt_model,
        tts=settings.livekit_tts_model,
        vad=ctx.proc.userdata["vad"],
        turn_handling={
            "turn_detection": MultilingualModel(),
            "endpointing": {"mode": "dynamic", "min_delay": 0.3, "max_delay": 3.0},
            "interruption": {
                "enabled": True,
                "mode": "adaptive",
                "false_interruption_timeout": 1.0,
                "resume_false_interruption": True,
                "discard_audio_if_uninterruptible": False,
            },
        },
        preemptive_generation=False,
        aec_warmup_duration=3.0,
    )

    _register_session_event_hooks(agent_session, conversation_id)

    await agent_session.start(
        room=ctx.room,
        agent=FeatherVoiceAgent(conversation_id),
    )

    greeting = _resolve_greeting(conversation)
    handle = agent_session.say(greeting, allow_interruptions=False)
    await handle.wait_for_playout()


def _resolve_greeting(conversation: Conversation) -> str:
    agent_turns = sorted(
        (event for event in conversation.events if event.type == EventType.AGENT_TURN),
        key=lambda event: event.sequence_no,
    )
    if not agent_turns:
        return INITIAL_GREETING
    return str(agent_turns[0].payload.get("text", INITIAL_GREETING))


def _register_session_event_hooks(session: AgentSession, conversation_id: UUID) -> None:
    session.on(
        "agent_state_changed",
        lambda ev: logger.info(
            "agent_state_changed conversation=%s state=%s",
            conversation_id,
            getattr(ev, "new_state", "unknown"),
        ),
    )
    session.on(
        "user_state_changed",
        lambda ev: logger.info(
            "user_state_changed conversation=%s state=%s",
            conversation_id,
            getattr(ev, "new_state", "unknown"),
        ),
    )
    session.on(
        "user_input_transcribed",
        lambda ev: logger.debug(
            "user_input_transcribed conversation=%s final=%s transcript=%s",
            conversation_id,
            getattr(ev, "is_final", False),
            getattr(ev, "transcript", ""),
        ),
    )
    session.on(
        "session_usage_updated",
        lambda ev: logger.info(
            "session_usage_updated conversation=%s usage=%s",
            conversation_id,
            getattr(ev, "usage", None),
        ),
    )
    session.on(
        "agent_false_interruption",
        lambda _: logger.info("agent_false_interruption conversation=%s", conversation_id),
    )


def run() -> None:
    cli.run_app(server)
