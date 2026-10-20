"""Closed CLI grammar shared by the user entry and approval launcher."""
import argparse
import uuid


def parser(launcher=False):
    p = argparse.ArgumentParser(allow_abbrev=False)
    p.add_argument('--plan', action='store_true')
    p.add_argument('--offer-session-bypass', action='store_true', help='Start a new plan session and offer an explicit session-wide bypass choice on its approval card')
    p.add_argument('--prompt', default=None)
    p.add_argument('--model')
    group = p.add_mutually_exclusive_group()
    group.add_argument('--resume', nargs='?', const='')
    group.add_argument('--continue', dest='continue_session', action='store_true')
    p.add_argument('--session-id')
    if launcher:
        p.add_argument('--state-dir', required=True)
    return p


def parse(argv, launcher=False):
    p = parser(launcher)
    # No positional or passthrough channel; argparse abbreviations are disabled.
    if '--' in argv:
        p.error('passthrough separator is not supported; use --prompt=TEXT')
    a = p.parse_args(argv)
    if a.offer_session_bypass and (a.resume is not None or a.continue_session):
        p.error('--offer-session-bypass requires a new session, not resume/continue')
    if a.session_id:
        try:
            if str(uuid.UUID(a.session_id)) != a.session_id.lower():
                raise ValueError()
        except ValueError:
            p.error('--session-id must be a UUID')
        if a.resume is not None or a.continue_session:
            p.error('--session-id cannot be combined with resume/continue')
    if a.model is not None and (not a.model or a.model.startswith('-')):
        p.error('invalid --model')
    if a.resume is not None and a.resume.startswith('-'):
        p.error('invalid --resume')
    return a
