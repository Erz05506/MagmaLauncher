#include "platform.h"

#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <cstring>

namespace platform {

bool applyX11WindowIdentity(unsigned long xwindow,
                            const std::vector<IconImage>& icons,
                            const std::string& wmClass,
                            const std::string& desktopFileId) {
    if (!xwindow) return false;
    Display* dpy = XOpenDisplay(nullptr);
    if (!dpy) return false;
    Window w = static_cast<Window>(xwindow);

    std::string cls = wmClass, name = wmClass;
    XClassHint hint;
    hint.res_name  = name.data();
    hint.res_class = cls.data();
    XSetClassHint(dpy, w, &hint);

    std::vector<unsigned long> data;  
    for (const auto& ic : icons) {
        if (ic.width <= 0 || ic.height <= 0 ||
            ic.argb.size() != static_cast<size_t>(ic.width) * ic.height) continue;
        data.push_back(static_cast<unsigned long>(ic.width));
        data.push_back(static_cast<unsigned long>(ic.height));
        for (uint32_t px : ic.argb) data.push_back(px);
    }
    if (!data.empty()) {
        Atom prop = XInternAtom(dpy, "_NET_WM_ICON", False);
        XChangeProperty(dpy, w, prop, XA_CARDINAL, 32, PropModeReplace,
                        reinterpret_cast<unsigned char*>(data.data()),
                        static_cast<int>(data.size()));
    }

    if (!desktopFileId.empty()) {
        Atom utf8 = XInternAtom(dpy, "UTF8_STRING", False);
        Atom kde  = XInternAtom(dpy, "_KDE_NET_WM_DESKTOP_FILE", False);
        XChangeProperty(dpy, w, kde, utf8, 8, PropModeReplace,
                        reinterpret_cast<const unsigned char*>(desktopFileId.c_str()),
                        static_cast<int>(desktopFileId.size()));
    }

    XSync(dpy, False);
    XCloseDisplay(dpy);
    return true;
}

} // namespace platform