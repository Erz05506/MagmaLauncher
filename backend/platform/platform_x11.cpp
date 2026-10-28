#include "platform.h"

#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <poll.h>

#include <atomic>
#include <cstring>
#include <thread>

namespace platform {

namespace {

struct Identity {
    std::vector<unsigned long> iconData;  
    std::string wmClass;
    std::string desktopFileId;           
    std::string appId;                    
};

Identity makeIdentity(const std::vector<IconImage>& icons,
                      const std::string& wmClass,
                      const std::string& desktopFileId) {
    Identity id;
    id.wmClass = wmClass;
    id.desktopFileId = desktopFileId;
    id.appId = desktopFileId;
    const std::string suffix = ".desktop";
    if (id.appId.size() > suffix.size() &&
        id.appId.compare(id.appId.size() - suffix.size(), suffix.size(), suffix) == 0) {
        id.appId.resize(id.appId.size() - suffix.size());
    }

    for (const auto& ic : icons) {
        if (ic.width <= 0 || ic.height <= 0 ||
            ic.argb.size() != static_cast<size_t>(ic.width) * ic.height) continue;
        id.iconData.push_back(static_cast<unsigned long>(ic.width));
        id.iconData.push_back(static_cast<unsigned long>(ic.height));
        for (uint32_t px : ic.argb) id.iconData.push_back(px);
    }
    return id;
}

bool sameProperty(Display* d, Window w, Atom prop, Atom type, int format,
                  const void* data, unsigned long count) {
    Atom actualType = None;
    int actualFormat = 0;
    unsigned long nitems = 0, bytesAfter = 0;
    unsigned char* got = nullptr;
    long wanted = (format == 32) ? static_cast<long>(count) + 1
                                 : static_cast<long>((count + 3) / 4) + 1;

    int st = XGetWindowProperty(d, w, prop, 0, wanted, False, type,
                                &actualType, &actualFormat, &nitems, &bytesAfter, &got);
    bool same = false;
    if (st == Success && got && actualType == type && actualFormat == format &&
        nitems == count && bytesAfter == 0) {
        size_t bytes = count * (format == 32 ? sizeof(long) : 1);
        same = std::memcmp(got, data, bytes) == 0;
    }
    if (got) XFree(got);
    return same;
}

void setPropertyIfDifferent(Display* d, Window w, Atom prop, Atom type, int format,
                            const void* data, unsigned long count) {
    if (sameProperty(d, w, prop, type, format, data, count)) return;
    XChangeProperty(d, w, prop, type, format, PropModeReplace,
                    static_cast<const unsigned char*>(data), static_cast<int>(count));
}

void ensureIdentity(Display* dpy, Window w, const Identity& id) {
    // WM_CLASS
    XClassHint cur{};
    bool classOk = false;
    if (XGetClassHint(dpy, w, &cur)) {
        classOk = cur.res_class && cur.res_name &&
                  id.wmClass == cur.res_class && id.wmClass == cur.res_name;
        if (cur.res_name) XFree(cur.res_name);
        if (cur.res_class) XFree(cur.res_class);
    }
    if (!classOk) {
        std::string name = id.wmClass, cls = id.wmClass;
        XClassHint hint;
        hint.res_name = name.data();
        hint.res_class = cls.data();
        XSetClassHint(dpy, w, &hint);
    }

    if (!id.iconData.empty()) {
        setPropertyIfDifferent(dpy, w, XInternAtom(dpy, "_NET_WM_ICON", False), XA_CARDINAL, 32,
                               id.iconData.data(), id.iconData.size());
    }

    Atom utf8 = XInternAtom(dpy, "UTF8_STRING", False);
    if (!id.desktopFileId.empty()) {
        setPropertyIfDifferent(dpy, w, XInternAtom(dpy, "_KDE_NET_WM_DESKTOP_FILE", False), utf8, 8,
                               id.desktopFileId.c_str(), id.desktopFileId.size());
    }
    if (!id.appId.empty()) {
        setPropertyIfDifferent(dpy, w, XInternAtom(dpy, "_GTK_APPLICATION_ID", False), utf8, 8,
                               id.appId.c_str(), id.appId.size());
    }

    XFlush(dpy);
}

void guardLoop(unsigned long xwindow, Identity id) {
    Display* dpy = XOpenDisplay(nullptr);
    if (!dpy) return;
    Window w = static_cast<Window>(xwindow);

    XSelectInput(dpy, w, PropertyChangeMask | StructureNotifyMask);
    ensureIdentity(dpy, w, id);

    const int fd = ConnectionNumber(dpy);
    for (;;) {
        pollfd pfd{fd, POLLIN, 0};
        poll(&pfd, 1, 3000);  

        while (XPending(dpy) > 0) {
            XEvent ev;
            XNextEvent(dpy, &ev);
            if (ev.type == DestroyNotify && ev.xdestroywindow.window == w) {
                XCloseDisplay(dpy);
                return;
            }
        }
        ensureIdentity(dpy, w, id);
    }
}

} // namespace

bool applyX11WindowIdentity(unsigned long xwindow,
                            const std::vector<IconImage>& icons,
                            const std::string& wmClass,
                            const std::string& desktopFileId) {
    if (!xwindow) return false;
    Display* dpy = XOpenDisplay(nullptr);
    if (!dpy) return false;

    ensureIdentity(dpy, static_cast<Window>(xwindow), makeIdentity(icons, wmClass, desktopFileId));
    XSync(dpy, False);
    XCloseDisplay(dpy);
    return true;
}

void guardX11WindowIdentity(unsigned long xwindow,
                            const std::vector<IconImage>& icons,
                            const std::string& wmClass,
                            const std::string& desktopFileId) {
    if (!xwindow) return;
    static std::atomic<bool> started{false};
    if (started.exchange(true)) return;

    std::thread(guardLoop, xwindow, makeIdentity(icons, wmClass, desktopFileId)).detach();
}

} // namespace platform