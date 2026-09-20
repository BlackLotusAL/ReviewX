# C++ Qt v1

按项目实际 Qt 版本核对 QObject 所有权和线程归属。检查 GUI 操作所在的线程、信号槽连接方式与实际接收对象；不要把 QThread 对象自身当成工作线程。
检查对象销毁后回调是否仍引用它，deleteLater 所在线程是否仍有事件循环，以及定时器、网络对象的使用线程。仅在变更引入具体错误时报告。
参考（本地规则来源，Agent 不联网）：https://doc.qt.io/archives/qt-5.15/threads-qobject.html
