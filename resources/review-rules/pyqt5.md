# PyQt5 v1

用于显式选择 PyQt5 的项目。检查 QObject 的父子所有权、Python 引用与 Qt 对象生命周期；按实际代码区分 pyqtSignal/pyqtSlot 和其他绑定。
检查 GUI 线程、跨线程信号槽、事件循环与定时器归属，不直接套用 PySide 或 Qt6 独有行为。异步回调中的对象引用必须有已读生命周期证据。
参考：https://www.riverbankcomputing.com/static/Docs/PyQt5/signals_slots.html
