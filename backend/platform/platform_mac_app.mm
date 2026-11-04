#import <Cocoa/Cocoa.h>
#include <functional>
#include <string>
#include <utility>

#include "include/cef_app.h"
#include "include/cef_application_mac.h"

#include "platform.h"

@interface MagmaApplication : NSApplication <CefAppProtocol> {
 @private
  BOOL handlingSendEvent_;
}
@end

@implementation MagmaApplication

- (BOOL)isHandlingSendEvent {
  return handlingSendEvent_;
}

- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  handlingSendEvent_ = handlingSendEvent;
}

- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sendingEventScoper;
  [super sendEvent:event];
}

- (void)terminate:(id)sender {
  NSArray* windows = [NSArray arrayWithArray:[self windows]];
  if ([windows count] == 0) {
    CefQuitMessageLoop();
    return;
  }
  for (NSWindow* window in windows) {
    [window performClose:nil];
  }
}

@end

static std::function<void(const std::string&)> g_macUrlHandler;
static std::string g_pendingMacUrl;

@interface MagmaApplicationDelegate : NSObject <NSApplicationDelegate>
@end

@implementation MagmaApplicationDelegate
- (void)application:(NSApplication*)application openURLs:(NSArray<NSURL*>*)urls {
  for (NSURL* url in urls) {
    const char* value = [[url absoluteString] UTF8String];
    if (!value) continue;
    std::string urlString(value);
    if (g_macUrlHandler) g_macUrlHandler(urlString);
    else g_pendingMacUrl = std::move(urlString);
  }
}
@end

namespace platform {

void setMacUrlHandler(std::function<void(const std::string&)> handler) {
  g_macUrlHandler = std::move(handler);
  if (g_macUrlHandler && !g_pendingMacUrl.empty()) {
    std::string pending = std::move(g_pendingMacUrl);
    g_pendingMacUrl.clear();
    g_macUrlHandler(pending);
  }
}

void macInitApplication() {
  [MagmaApplication sharedApplication];
  static MagmaApplicationDelegate* appDelegate = [[MagmaApplicationDelegate alloc] init];
  [NSApp setDelegate:appDelegate];

  NSMenu* menuBar = [[NSMenu alloc] init];

  NSMenuItem* appItem = [[NSMenuItem alloc] init];
  [menuBar addItem:appItem];
  NSMenu* appMenu = [[NSMenu alloc] init];
  [appMenu addItemWithTitle:@"Hide MagmaLauncher" action:@selector(hide:) keyEquivalent:@"h"];
  [appMenu addItem:[NSMenuItem separatorItem]];
  [appMenu addItemWithTitle:@"Quit MagmaLauncher" action:@selector(terminate:) keyEquivalent:@"q"];
  [appItem setSubmenu:appMenu];

  NSMenuItem* editItem = [[NSMenuItem alloc] init];
  [menuBar addItem:editItem];
  NSMenu* editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
  [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
  [editMenu addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
  [editMenu addItem:[NSMenuItem separatorItem]];
  [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
  [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  [editItem setSubmenu:editMenu];

  NSMenuItem* windowItem = [[NSMenuItem alloc] init];
  [menuBar addItem:windowItem];
  NSMenu* windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
  [windowMenu addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
  [windowMenu addItemWithTitle:@"Close" action:@selector(performClose:) keyEquivalent:@"w"];
  [windowItem setSubmenu:windowMenu];

  [NSApp setMainMenu:menuBar];
  [NSApp setWindowsMenu:windowMenu];
}

}