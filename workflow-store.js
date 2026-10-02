/* Durable action history; independent of the 100-image evidence limit. */
const WorkflowStore = (() => {
  let queue = Promise.resolve();
  const run = task => {
    const result = queue.then(task);
    queue = result.catch(error => console.warn('[Workflow]', error));
    return result;
  };
  const empty = sessionId => ({version:2,sessionId,actions:[],nextSequence:1,error:null});
  async function read(sessionId) {
    const {workflow} = await chrome.storage.local.get({workflow:null});
    return workflow?.sessionId === sessionId ? workflow : empty(sessionId);
  }
  async function append(action, expectedSession) {
    return run(async () => {
      const {session,recording} = await chrome.storage.local.get({session:null,recording:true});
      if (!session?.id || !recording || (expectedSession && session.id !== expectedSession)) return false;
      const workflow = await read(session.id);
      if (workflow.error) return false;
      // Stop explicitly rather than silently truncate a runnable workflow.
      if (workflow.actions.length >= 5000) {
        workflow.error = 'Action limit reached (5000). Start a new session; this recording is incomplete.';
      } else {
        const previous = workflow.actions.at(-1);
        const sameTarget = previous && previous.tabId === action.tabId && previous.url === action.url && previous.topUrl === action.topUrl && JSON.stringify(previous.frames) === JSON.stringify(action.frames) && JSON.stringify(previous.locator) === JSON.stringify(action.locator);
        if (action.type === 'fill' && previous?.type === 'fill' && sameTarget) {
          workflow.actions[workflow.actions.length - 1] = {...action,sequence:previous.sequence};
        } else if (action.type === 'doubleClick' && previous?.type === 'click' && sameTarget) {
          workflow.actions[workflow.actions.length - 1] = {...action,sequence:previous.sequence};
        } else if (!(action.type === 'popup' && workflow.actions.some(item => item.type === 'popup' && item.tabId === action.tabId))) {
          workflow.actions.push({...action,sequence:workflow.nextSequence++});
        }
      }
      try { await chrome.storage.local.set({workflow}); }
      catch (error) {
        // Retain a small explicit failure marker if the full log exhausted storage.
        await chrome.storage.local.set({workflow:{...empty(session.id),error:'Action history could not be saved: ' + error.message}});
        throw error;
      }
      return true;
    });
  }
  async function snapshot(sessionId) { await queue; return read(sessionId); }
  async function reset(sessionId) { return run(() => chrome.storage.local.set({workflow:empty(sessionId)})); }
  return {append,snapshot,reset};
})();
