import assert from 'node:assert/strict'
import test from 'node:test'
import { addConversationImageDraft } from '../src/client/conversation-sync.ts'
import { conversationSessionTargets, currentConversationSessionId } from '../src/client/session-target.ts'

const sessionA = 'session-a'
const sessionB = 'session-b'

function snapshot(current) {
  return {
    ids: [sessionA, sessionB],
    current,
    byId: {
      [sessionA]: { displayTitle: 'Older session' },
      [sessionB]: { displayTitle: 'Most recent session' },
    },
  }
}

test('current target uses only the authoritative selection and never list order', () => {
  const state = snapshot(undefined)
  const sessions = { list: { getSnapshot: () => state } }
  assert.equal(currentConversationSessionId(sessions), undefined)
  assert.deepEqual(conversationSessionTargets(state), [
    { id: sessionA, title: 'Older session' },
    { id: sessionB, title: 'Most recent session' },
  ])
  state.current = sessionA
  assert.equal(currentConversationSessionId(sessions), sessionA)
})

function createComposerHarness({ accepts = true, apiError } = {}) {
  const calls = []
  const input = {
    addAttachments(ids) { calls.push(['composer.addAttachments', ids]); return accepts },
    removeAttachment(id) { calls.push(['composer.removeAttachment', id]); return true },
    state: { getSnapshot: () => ({ draft: '' }) },
    setDraft(text) { calls.push(['composer.setDraft', text]) },
  }
  const conversation = {
    createDrafts(sessionId, files) {
      calls.push(['conversation.createDrafts', sessionId, files[0].name])
      return [{ id: 'draft-image-1', kind: 'file' }]
    },
    releaseDraftAttachments(attachments) { calls.push(['conversation.releaseDrafts', attachments.map(item => item.id)]) },
    input: { for(scope) { calls.push(['conversation.input.for', scope.sessionId]); return input } },
  }
  const attachImage = async (sessionId, dataUrl, name) => {
    calls.push(['api.attachConversationImage', sessionId, dataUrl, name])
    if (apiError !== undefined) throw apiError
  }
  return { calls, conversation, attachImage }
}

const common = {
  sessionId: sessionA,
  sessionScope: { sessionId: sessionA },
  file: new File(['png'], 'dsh-image-1.png', { type: 'image/png' }),
  dataUrl: 'data:image/png;base64,cG5n',
  name: 'dsh-image-1.png',
  prompt: 'A generated image prompt',
  unavailableMessage: 'composer unavailable',
  busyMessage: 'composer busy',
}

test('image attachment keeps draft → composer → durable staging → prompt order', async () => {
  const harness = createComposerHarness()
  await addConversationImageDraft({ ...common, ...harness })
  assert.deepEqual(harness.calls, [
    ['conversation.createDrafts', sessionA, 'dsh-image-1.png'],
    ['conversation.input.for', sessionA],
    ['composer.addAttachments', ['draft-image-1']],
    ['api.attachConversationImage', sessionA, common.dataUrl, common.name],
    ['composer.setDraft', common.prompt],
  ])
})

test('a busy composer releases its unaccepted draft and does not stage the image', async () => {
  const harness = createComposerHarness({ accepts: false })
  await assert.rejects(addConversationImageDraft({ ...common, ...harness }), /composer busy/)
  assert.deepEqual(harness.calls, [
    ['conversation.createDrafts', sessionA, 'dsh-image-1.png'],
    ['conversation.input.for', sessionA],
    ['composer.addAttachments', ['draft-image-1']],
    ['conversation.releaseDrafts', ['draft-image-1']],
  ])
})

test('durable staging failure removes the composer chip and releases its draft', async () => {
  const harness = createComposerHarness({ apiError: new Error('local route failed') })
  await assert.rejects(addConversationImageDraft({ ...common, ...harness }), /local route failed/)
  assert.deepEqual(harness.calls.map(call => call[0]), [
    'conversation.createDrafts',
    'conversation.input.for',
    'composer.addAttachments',
    'api.attachConversationImage',
    'composer.removeAttachment',
    'conversation.releaseDrafts',
  ])
})
