"""Add the three-file follow-up's real fixtures/conversions to the same harness."""
import re


def augment(read, block, declaration, src, up, build):
    projection = read(src / 'mobile_client/thread_projection.rs')
    requests = read(src / 'types/server_requests.rs')
    profile = read(src / 'perf_profile.rs')
    models = read(src / 'types/models.rs')
    snapshot = read(src / 'store/snapshot.rs')
    turn = read(up / 'app-server-protocol/src/protocol/v2/turn.rs')
    # Keep the actual TextElement constructor used by outgoing text projections.
    with (build / 'protocol.rs').open('a') as output:
        output.write('\n' + block(turn, turn.index('impl TextElement {')))
    mobile_names = ['AbsolutePath', 'AppByteRange', 'AppTextElement', 'AppUserInput']
    with (build / 'types.rs').open('a') as output:
        output.write('\n' + '\n'.join(declaration(models, name) for name in mobile_names))
    queue_types = 'use crate as upstream;\n' + '\n'.join(
        declaration(snapshot, name) for name in [
            'AppQueuedFollowUpKind', 'AppQueuedFollowUpPreview', 'QueuedFollowUpDraft'])
    (build / 'store.rs').write_text(queue_types)
    queue = 'use crate as upstream; use crate::{store::*, uuid};\n'
    for name in ['queued_follow_up_draft_from_inputs', 'queued_follow_up_text_from_inputs',
                 'queued_follow_up_inputs_from_json_value', 'queued_follow_up_message_json_from_inputs',
                 'string_field', 'attachment_summary']:
        queue += '\n' + block(projection, projection.index('fn '+name))
    queue += '\n' + block(projection, projection.index('mod image_reference_tests'))
    queue += '\n' + block(projection, projection.index('mod audio_compat_tests'))
    (build / 'queue_projection.rs').write_text(queue)
    outgoing = 'use crate as upstream; use crate::{RpcClientError, types::*}; use std::path::PathBuf;\n'
    for name in ['path_buf_from_mobile', 'byte_range_into_upstream', 'text_element_into_upstream', 'user_input_into_upstream']:
        outgoing += '\n' + block(requests, requests.index('fn '+name))
    outgoing += '\n' + block(requests, requests.index('mod image_reference_tests'))
    (build / 'outgoing_inputs.rs').write_text(outgoing)
    # Execute only fixture construction/hydration; do not run the ignored
    # performance benchmark's allocation instrumentation or timing loop.
    fixture = re.search(r'    let turns = \(0\.\.20\)[\s\S]+?\.collect::<Vec<_>>\(\);', profile)
    assert fixture, 'benchmark fixture was moved; review extraction'
    perf = '''use crate::{ThreadItem, ThreadItemPayload, Turn, TurnItemsView, TurnStatus};
#[test]
fn benchmark_fixture_keeps_ids_optional_metadata_and_turn_times() {
''' + fixture[0] + '''
    assert_eq!(turns.len(), 20);
    for (turn_index, turn) in turns.iter().enumerate() {
        assert_eq!(turn.id, format!("turn-{turn_index}"));
        assert_eq!(turn.root_turn_id, None);
        assert_eq!(turn.started_at, Some(turn_index as i64));
        assert_eq!(turn.completed_at, Some(turn_index as i64 + 1));
        assert_eq!(turn.duration_ms, Some(1_000));
        assert_eq!(turn.items.len(), 100);
        for (item_index, item) in turn.items.iter().enumerate() {
            assert_eq!(item.id(), format!("item-{turn_index}-{item_index}"));
            assert_eq!(item.started_at_ms, None);
            assert_eq!(item.completed_at_ms, None);
            assert!(matches!(&item.payload, ThreadItemPayload::AgentMessage {
                phase: None, memory_citation: None, delivery: None, questions: None, text, ..
            } if text == &"assistant response text ".repeat(40)));
        }
    }
    assert_eq!(crate::conversation::hydrate_turns(&turns, &Default::default()).len(), 2000);
}
'''
    (build / 'profile_fixture.rs').write_text(perf)
    error = declaration(read(src / 'lib.rs'), 'RpcClientError').replace(', thiserror::Error', '')
    return '''
pub use types::{AbsolutePath, AppByteRange, AppTextElement, AppUserInput};
mod store;
#[cfg(test)] mod queue_projection;
#[cfg(test)] mod outgoing_inputs;
#[cfg(test)] mod profile_fixture;
// Harness-only deterministic queue ID: UUID generation is not under test.
mod uuid {
    pub struct Uuid;
    impl Uuid { pub fn new_v4() -> &'static str { "fixture-queue-id" } }
}
''' + error
