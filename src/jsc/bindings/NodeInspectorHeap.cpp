#include "root.h"
#include "NodeInspectorHeap.h"

#include "ErrorCode.h"
#include "ScriptExecutionContext.h"
#include "ZigGlobalObject.h"
#include <JavaScriptCore/InspectorHeapAgent.h>
#include <JavaScriptCore/JSGlobalObjectInspectorController.h>
#include <JavaScriptCore/JSPromise.h>
#include <JavaScriptCore/ObjectConstructor.h>
#include <atomic>

namespace Bun {
using namespace JSC;
using namespace WebCore;

// This object may cross VM threads. Promises remain in the origin context's map.
struct InspectorHeapRequest {
    enum class State : uint8_t { Pending, Running, Completed, Cancelled };
    const uint64_t id;
    const ScriptExecutionContextIdentifier origin;
    const ScriptExecutionContextIdentifier target;
    const BunLoopKind originLoop;
    const bool mainThread;
    std::atomic<State> state { State::Pending };

    void finish(const std::shared_ptr<InspectorHeapRequest>& self, bool success)
    {
        auto observed = state.load(std::memory_order_acquire);
        do {
            if (observed == State::Cancelled || observed == State::Completed)
                return;
        } while (!state.compare_exchange_weak(observed, State::Completed, std::memory_order_acq_rel));
        ScriptExecutionContext::postTaskTo(origin, originLoop, [self, success](ScriptExecutionContext& context) {
            if (context.identifier() != self->origin || context.isJSExecutionForbidden())
                return;
            if (auto* owner = context.existingNodeInspectorHeapRequests())
                owner->complete(self, success);
        });
    }
};

// Accepted tasks may be discarded during target teardown without being invoked.
// Only this delivery guard crosses threads; it owns no JS handles.
class InspectorHeapDelivery {
public:
    explicit InspectorHeapDelivery(std::shared_ptr<InspectorHeapRequest> request)
        : m_request(WTF::move(request)) { }
    ~InspectorHeapDelivery() { m_request->finish(m_request, false); }

    void run()
    {
        const auto& request = m_request;
        auto* context = ScriptExecutionContext::getScriptExecutionContext(request->target);
        if (!context || !context->isContextThread() || context->isTerminating()
            || context->isJSExecutionForbidden() || context->activeDOMObjectsAreStopped()
            || request->state.load(std::memory_order_acquire) != InspectorHeapRequest::State::Pending
            || (request->mainThread && !context->isMainThread()))
            return;

        auto& vm = context->vm();
        ASSERT(!vm.entryScope);
        auto& agent = context->jsGlobalObject()->inspectorController().ensureHeapAgent();
        auto expected = InspectorHeapRequest::State::Pending;
        // This is the admission point; disconnect cancels requests not yet admitted.
        if (!request->state.compare_exchange_strong(expected, InspectorHeapRequest::State::Running, std::memory_order_acq_rel))
            return;
        auto result = agent.gc();
        request->finish(request, !!result);
    }

private:
    std::shared_ptr<InspectorHeapRequest> m_request;
};

NodeInspectorHeapRequests::NodeInspectorHeapRequests(ScriptExecutionContext& context)
    : m_context(context) { }

NodeInspectorHeapRequests::~NodeInspectorHeapRequests()
{
    ASSERT(m_pending.isEmpty());
}

JSValue NodeInspectorHeapRequests::request(JSGlobalObject* globalObject, bool mainThread)
{
    auto& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    ASSERT(m_context.isContextThread());
    if (m_stopped || m_context.isJSExecutionForbidden() || m_context.activeDOMObjectsAreStopped()) {
        throwVMError(globalObject, scope, createError(globalObject, ErrorCode::ERR_INSPECTOR_CLOSED, "Session was closed"_s));
        return { };
    }
    if (m_nextId > 9007199254740991ULL) {
        throwVMError(globalObject, scope, createRangeError(globalObject, "Inspector request identifiers exhausted"_s));
        return { };
    }

    auto id = m_nextId++;
    auto request = std::make_shared<InspectorHeapRequest>(id, m_context.identifier(), mainThread ? 1 : m_context.identifier(), m_context.currentLoopKind(), mainThread);
    auto* promise = JSPromise::create(vm, globalObject->promiseStructure());
    Strong<JSPromise> protectedPromise(vm, promise);
    JSObject* result = constructEmptyObject(globalObject);
    putDirectNamed(vm, result, "id"_s, jsNumber(id));
    putDirectNamed(vm, result, "promise"_s, promise);
    RETURN_IF_EXCEPTION(scope, { });
    m_pending.add(id, Pending { request, WTF::move(protectedPromise) });
    m_context.refEventLoop();

    auto delivery = std::make_shared<InspectorHeapDelivery>(request);
    ScriptExecutionContext::postTaskTo(request->target, BunLoopKind::Regular, [delivery, request](ScriptExecutionContext& context) {
        if (context.identifier() != request->target || context.isJSExecutionForbidden())
            return;
        // The regular queue can be serviced by an embedding loop. Wait for the
        // outermost JS entry to unwind rather than collecting in a nested entry.
        context.vm().whenIdle([delivery] { delivery->run(); });
    });
    return result;
}

void NodeInspectorHeapRequests::cancel(JSGlobalObject* globalObject, uint64_t id)
{
    ASSERT(m_context.isContextThread());
    auto pending = m_pending.take(id);
    if (!pending.request)
        return;
    pending.request->state.store(InspectorHeapRequest::State::Cancelled, std::memory_order_release);
    m_context.unrefEventLoop();
    if (m_context.isJSExecutionForbidden())
        return;
    if (auto* error = createError(globalObject, ErrorCode::ERR_INSPECTOR_CLOSED, "Session was closed"_s))
        pending.promise->reject(globalObject->vm(), error);
}

void NodeInspectorHeapRequests::complete(const std::shared_ptr<InspectorHeapRequest>& request, bool success)
{
    ASSERT(m_context.isContextThread());
    auto found = m_pending.find(request->id);
    if (found == m_pending.end() || found->value.request != request)
        return;
    auto promise = WTF::move(found->value.promise);
    m_pending.remove(found);
    m_context.unrefEventLoop();
    if (m_context.isJSExecutionForbidden())
        return;
    auto* globalObject = m_context.jsGlobalObject();
    auto& vm = globalObject->vm();
    if (success)
        promise->resolve(globalObject, vm, constructEmptyObject(globalObject));
    else if (auto* error = createError(globalObject, ErrorCode::ERR_INSPECTOR_COMMAND, "-32000: Inspector target is unavailable"_s))
        promise->reject(vm, error);
}

void NodeInspectorHeapRequests::stop()
{
    ASSERT(m_context.isContextThread());
    m_stopped = true;
    for (auto& entry : m_pending) {
        entry.value.request->state.store(InspectorHeapRequest::State::Cancelled, std::memory_order_release);
        m_context.unrefEventLoop();
    }
    // The origin context is retiring; drop its JS handles on that context's thread.
    m_pending.clear();
}

JSC_DEFINE_HOST_FUNCTION(requestInspectorHeapCollection, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    auto* context = defaultGlobalObject(globalObject)->scriptExecutionContext();
    return JSValue::encode(context->nodeInspectorHeapRequests().request(globalObject, callFrame->argument(0).toBoolean(globalObject)));
}

JSC_DEFINE_HOST_FUNCTION(cancelInspectorHeapCollection, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    auto* context = defaultGlobalObject(globalObject)->scriptExecutionContext();
    if (auto* owner = context->existingNodeInspectorHeapRequests())
        owner->cancel(globalObject, static_cast<uint64_t>(callFrame->argument(0).asNumber()));
    return JSValue::encode(jsUndefined());
}

JSObject* createNodeInspectorHeapBinding(JSGlobalObject* globalObject)
{
    auto& vm = globalObject->vm();
    auto* object = constructEmptyObject(globalObject);
    object->putDirectNativeFunction(vm, globalObject, Identifier::fromString(vm, "request"_s), 1, requestInspectorHeapCollection, ImplementationVisibility::Private, NoIntrinsic, 0);
    object->putDirectNativeFunction(vm, globalObject, Identifier::fromString(vm, "cancel"_s), 1, cancelInspectorHeapCollection, ImplementationVisibility::Private, NoIntrinsic, 0);
    return object;
}
}
