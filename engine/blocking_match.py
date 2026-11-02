"""Pure local matching, also shipped into the engine image. No network access."""
import re

# ARCEP plan §2.3.7, decision 2025-2215, checked 2026-11-02.
ARCEP_PREFIXES = tuple('+33' + p for p in (
    '162', '163', '270', '271', '377', '378', '424', '425', '568', '569', '948', '949'
)) + ('+5905987', '+5909475', '+5945988', '+5949476', '+5965989', '+5969477',
      '+2622688', '+2622689', '+2629478', '+2629479')
DEFAULT_CONFIG = {'mode': 'monitor', 'arcep': False, 'saracroche': False,
                  'block_withheld': False, 'block_unavailable': False}


def normalize(value, prefix=False):
    value = (value or '').strip()
    if len(value) > 128:
        return None
    m = re.search(r'(?:sip:|sips:|tel:)([^@;>]+)', value, re.I)
    if m:
        value = m.group(1)
    value = re.sub(r'[\s().-]', '', value)
    if value.startswith('00'):
        value = '+' + value[2:]
    elif value.startswith('0'):
        # Domestic notation is metropolitan French. Overseas callers use E.164.
        value = '+33' + value[1:]
    minimum = 2 if prefix else 7
    if not re.fullmatch(r'\+[1-9][0-9]{%d,14}' % (minimum - 1), value):
        return None
    if not prefix and value.startswith('+33') and len(value) != 12:
        return None
    return value


def decision(conn, caller, presentation='allowed'):
    settings = dict(conn.execute('SELECT key,value FROM settings'))
    mode = settings['mode']
    incoming = normalize(caller)
    if incoming is None and re.fullmatch(r'[1-9][0-9]{1,5}', (caller or '').strip()):
        incoming = caller.strip()
    result = {'mode': mode, 'normalized': incoming, 'would_block': False,
              'action': 'allow', 'source': 'none', 'rule': '', 'reason': 'No enabled rule matched'}
    if mode == 'disabled':
        result['reason'] = 'Filtering disabled'
        return result
    number = result['normalized']
    # Do not treat a restricted identity (even one containing digits) as a usable number.
    if str(presentation).isdigit():
        code = int(presentation) & 0x60
        presentation = 'prohib' if code == 0x20 else 'unavailable' if code == 0x40 else 'allowed'
    withheld = presentation.startswith('prohib') or (caller or '').strip().lower() in (
        'anonymous', 'private', 'withheld', 'restricted')
    unavailable = not number or presentation == 'unavailable'
    if withheld or unavailable:
        kind = 'withheld' if withheld else 'unavailable'
        match = settings.get('block_' + kind) == 'true'
        result.update(source=kind if match else 'none', rule=kind if match else '',
                      reason=f'{kind.capitalize()} caller ID')
    else:
        candidates = [number[:i] for i in range(1, len(number) + 1)]
        # Android '#' masks match one digit each, with an exact total length.
        candidates += [number[:i] + '#' * (len(number) - i) for i in range(1, len(number))]
        placeholders = ','.join('?' for _ in candidates)
        def find(kind):
            return conn.execute(
                f'SELECT number,kind,priority FROM rules WHERE kind=? AND number IN ({placeholders}) '
                'AND (match_type IN (\'prefix\',\'android\') OR number=?) '
                'ORDER BY priority ASC,length(replace(number,\'#\',\'\')) DESC LIMIT 1',
                (kind, *candidates, number)).fetchone()
        allowed = find('allow')
        if allowed:
            result.update(source='whitelist', rule=allowed[0], reason='Personal whitelist')
            return result
        blocked = find('block')
        arcep = next((p for p in ARCEP_PREFIXES if number.startswith(p)), None)
        imported = find('saracroche') if settings.get('saracroche') == 'true' else None
        provider_allow = find('saracroche_allow') if settings.get('saracroche') == 'true' else None
        if provider_allow and (not imported or provider_allow[2] <= imported[2]):
            imported = provider_allow
        match = bool(blocked or (arcep and settings.get('arcep') == 'true')
                     or (imported and imported[1] == 'saracroche'))
        if blocked:
            result.update(source='blacklist', rule=blocked[0], reason='Personal blacklist')
        elif arcep and settings.get('arcep') == 'true':
            result.update(source='arcep', rule=arcep, reason='ARCEP verified automated-calling range')
        elif imported:
            result.update(source='saracroche', rule=imported[0], reason='Saracroche allowlist' if imported[1] == 'saracroche_allow' else 'Saracroche blocklist')
    result['would_block'] = bool(match)
    result['action'] = 'reject' if match and mode == 'enforce' else 'allow'
    return result
