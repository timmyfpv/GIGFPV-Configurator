let handlers = {
    disconnect: null,
    scheduleRebootReconnect: null,
};

export function isDrivenRebootTarget(port) {
    return typeof port === "string" && (port.startsWith("bluetooth") || port === "manual");
}

export function setRebootReconnectHandlers(nextHandlers) {
    handlers = {
        ...handlers,
        ...nextHandlers,
    };
}

export function disconnectForCliReconnect() {
    handlers.disconnect?.();
}

export function scheduleDrivenCliReconnect() {
    handlers.scheduleRebootReconnect?.();
}
