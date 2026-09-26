#pragma once

#include "root.h"
#include <JavaScriptCore/Strong.h>
#include <wtf/HashMap.h>
#include <memory>

namespace JSC {
class JSPromise;
}
namespace WebCore {
class ScriptExecutionContext;
}

namespace Bun {
struct InspectorHeapRequest;

class NodeInspectorHeapRequests {
public:
    explicit NodeInspectorHeapRequests(WebCore::ScriptExecutionContext&);
    ~NodeInspectorHeapRequests();
    JSC::JSValue request(JSC::JSGlobalObject*, bool mainThread);
    void cancel(JSC::JSGlobalObject*, uint64_t);
    void complete(const std::shared_ptr<InspectorHeapRequest>&, bool success);
    void stop();

private:
    struct Pending {
        std::shared_ptr<InspectorHeapRequest> request;
        JSC::Strong<JSC::JSPromise> promise;
    };
    WebCore::ScriptExecutionContext& m_context;
    HashMap<uint64_t, Pending> m_pending;
    uint64_t m_nextId { 1 };
    bool m_stopped { false };
};

JSC::JSObject* createNodeInspectorHeapBinding(JSC::JSGlobalObject*);
}
