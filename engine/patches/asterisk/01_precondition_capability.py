"""Wire real sysmocom IMS preconditions into PJPROJECT's per-request validation.

Replaces the old untracked global capability registration. No Require/SDP mutation,
no global endpoint capability and no change to the existing QoS state machine.
"""
from pathlib import Path
import argparse

MARKER = 'VOWIFI_IMS_PRECONDITION_V1'


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Pinned source anchor changed; refusing partial precondition patch')
    return text.replace(old, new, 1)


def apply(root):
    paths = [root/'pjproject/pjsip/include/pjsip-ua/sip_inv.h',
             root/'pjproject/pjsip/src/pjsip-ua/sip_inv.c',
             root/'asterisk/res/res_pjsip_session.c']
    original = [path.read_text() for path in paths]
    if all(MARKER in value for value in original):
        return
    if any(MARKER in value for value in original):
        raise RuntimeError('Partial precondition patch found; use a clean build')
    header, verifier, session = original
    header = replace_once(header, '    PJSIP_INV_REQUIRE_TRICKLE_ICE = 512,', '''    PJSIP_INV_REQUIRE_TRICKLE_ICE = 512,

    /* VOWIFI_IMS_PRECONDITION_V1: application has a real RFC 3312 handler
     * for THIS request/session. Never registered on the global endpoint. */
    PJSIP_INV_SUPPORT_PRECONDITION = 1024,''')
    anchor = '''            } else if (!pjsip_endpt_has_capability(endpt, PJSIP_H_SUPPORTED,
                                                   NULL, &req_hdr->values[i]))'''
    verifier = replace_once(verifier, anchor, '''            } else if ((*options & PJSIP_INV_SUPPORT_PRECONDITION) &&
                       pj_stricmp2(&req_hdr->values[i], "precondition") == 0)
            {
                /* VOWIFI_IMS_PRECONDITION_V1: validated by the application's
                 * per-request IMS handler; preserve Require and the SDP. */
            } else if (!pjsip_endpt_has_capability(endpt, PJSIP_H_SUPPORTED,
                                                   NULL, &req_hdr->values[i]))''')
    anchor = '''                    sup_hdr = (pjsip_supported_hdr*)
                              pjsip_hdr_clone(tmp_pool, h);
                    pj_list_push_back(&res_hdr_list, sup_hdr);'''
    verifier = replace_once(verifier, anchor, '''                    sup_hdr = (pjsip_supported_hdr*)
                              pjsip_hdr_clone(tmp_pool, h);
                    /* Accurate support on this IMS error response only. */
                    if ((*options & PJSIP_INV_SUPPORT_PRECONDITION) &&
                        sup_hdr->count < PJSIP_GENERIC_ARRAY_MAX_COUNT)
                    {
                        sup_hdr->values[sup_hdr->count++] = pj_str("precondition");
                    }
                    pj_list_push_back(&res_hdr_list, sup_hdr);''')
    anchor = '''\tif (pjsip_inv_verify_request(rdata, &options, NULL, NULL, ast_sip_get_pjsip_endpoint(), &tdata) != PJ_SUCCESS) {'''
    session = replace_once(session, anchor, '''\t/* VOWIFI_IMS_PRECONDITION_V1: the existing sysmocom IMS session
\t * implements PRACK/UPDATE/QoS. Ordinary SIP endpoints do not opt in. */
\tif (endpoint->volte && endpoint->precondition_supported) {
\t\toptions |= PJSIP_INV_SUPPORT_PRECONDITION;
\t}

'''+anchor)
    # Scope Supported advertisement to actual SIP session responses for IMS.
    start = session.index('static void handle_outgoing_response(')
    # The declaration precedes the definition in this source; locate the definition.
    start = session.index('static void handle_outgoing_response(', start + 1)
    prefix, response = session[:start], session[start:]
    anchor = '''\t\t/* Add "precondition" to Require header. */'''
    location = response.index(anchor)
    response = response[:location]+'''\t\t/* Advertise the implemented extension for this IMS endpoint only. */
\t\tif (session->endpoint->precondition_supported) {
\t\t\tpjsip_supported_hdr *supported = pjsip_msg_find_hdr(tdata->msg, PJSIP_H_SUPPORTED, NULL);
\t\t\tpj_bool_t present = PJ_FALSE;
\t\t\tunsigned int i;
\t\t\tfor (i = 0; supported && i < supported->count; ++i) {
\t\t\t\tif (pj_stricmp2(&supported->values[i], "precondition") == 0) {
\t\t\t\t\tpresent = PJ_TRUE;
\t\t\t\t}
\t\t\t}
\t\t\tif (!present && ((supported && supported->count >= PJSIP_GENERIC_ARRAY_MAX_COUNT) ||
\t\t\t    volte_add_supported_precondition(tdata))) {
\t\t\t\tast_log(LOG_ERROR, "Failed to add precondition to Supported header.\\n");
\t\t\t}
\t\t}

'''+response[location:]
    session = prefix + response
    # Compute/validate every edit before writing any file.
    for path, text in zip(paths, [header, verifier, session]):
        path.write_text(text)
    print('Applied endpoint-scoped IMS precondition validation and advertisement')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/home/asterisk-build'))
    apply(parser.parse_args().root)
