"""Parser for `pi-phase status` output, shared by dev-doctor, bin_sweep and docker-guardian."""
import re

IDLE = 'pi-phase: no active phases'
# Line shape written by pi_phase.py: <head> elapsed=<N>s <state>[ fast][ policy=<p>][ source=<s>]
# Only these trailing fields are accepted; anything else makes the line malformed.
ACTIVE = re.compile(r'^pi-phase: (?P<kind>\S+) (?P<head>.*?)elapsed=(?P<elapsed>\d+)s '
                    r'(?P<state>running|orphan-group)(?P<fast> fast)?'
                    r'(?: policy=(?P<policy>[\w.:-]+))?(?: source=(?P<source>[\w.:-]+))?$')


def active_phases(text):
    """Active phases as dicts, [] when idle, None when the status is unavailable or unparseable."""
    if text is None:
        return None
    lines = text.splitlines()
    active = []
    for line in lines:
        match = ACTIVE.match(line)
        if match:
            cwd = re.search(r'\bcwd=(.+?)\s*$', match['head'])
            active.append(dict(kind=match['kind'], state=match['state'], cwd=cwd[1] if cwd else None,
                               fast=bool(match['fast']), policy=match['policy'], source=match['source']))
        elif line.startswith('pi-phase: ') and ' elapsed=' in line:
            return None  # an active-looking line we cannot read: state is unknown
    if active:
        return active
    return [] if IDLE in lines else None
