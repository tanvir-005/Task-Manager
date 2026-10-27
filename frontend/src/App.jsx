import { useCallback, useEffect, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";

import {
  CalendarDays,
  CalendarCheck,
  CheckCircle2,
  Ban,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Plus,
  Send,
  Paperclip,
  Menu,
  LoaderCircle,
  X,
  Clock3,
  ChevronDown,
} from "lucide-react";

import { Button } from "@/components/ui/button";

function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function App() {
  const calendarRef = useRef(null);
  const fileInputRef = useRef(null);

  const [view, setView] = useState("timeGridWeek");
  const [activeSection, setActiveSection] = useState("calendar");
  const [historyTasks, setHistoryTasks] = useState([]);
  const [selectedTask, setSelectedTask] = useState(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [categories, setCategories] = useState([]);
  const [activeCategories, setActiveCategories] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState("");
  const [responseMessage, setResponseMessage] = useState("");
  const [operationResults, setOperationResults] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [files, setFiles] = useState([]);

  const calendarApi = () => calendarRef.current?.getApi();

  useEffect(() => {
    let cancelled = false;

    async function loadCategories() {
      try {
        const response = await fetch("/api/categories");

        if (!response.ok) {
          throw new Error("Could not load categories.");
        }

        const data = await response.json();

        if (!cancelled) {
          setCategories(data);
          setActiveCategories(data.map((category) => category.name));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not connect to the backend.");
        }
      }
    }

    loadCategories();

    return () => {
      cancelled = true;
    };
  }, []);

  const loadCalendarEvents = useCallback(
    async (fetchInfo, successCallback, failureCallback) => {
      try {
        const params = new URLSearchParams({
          start: formatLocalDateTime(fetchInfo.start),
          end: formatLocalDateTime(fetchInfo.end),
        });

        const response = await fetch(`/api/tasks?${params.toString()}`);

        if (!response.ok) {
          throw new Error("Could not load tasks from the backend.");
        }

        const tasks = await response.json();

        const now = new Date();
        const events = tasks
          .filter(
            (task) =>
              ["pending", "postponed"].includes(task.status) &&
              activeCategories.includes(task.category),
          )
          .map((task) => {
            const overdue =
              new Date(task.end).getTime() < now.getTime();
            return {
            id: String(task.id),
            title: task.title,
            start: task.start,
            end: task.end,
            backgroundColor: overdue ? "#B91C1C" : task.color,
            borderColor: overdue ? "#991B1B" : task.color,
            textColor: "#ffffff",
            classNames: [
              `task-status-${task.status}`,
              overdue ? "task-overdue" : "",
            ].filter(Boolean),
            extendedProps: {
              description: task.description,
              category: task.category,
              status: overdue ? "overdue" : task.status,
              task,
            },
          };
          });

        successCallback(events);
      } catch (err) {
        setError(err.message || "Could not load calendar events.");
        failureCallback(err);
      }
    },
    [activeCategories],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadHistoryTasks() {
      setIsLoadingHistory(true);
      try {
        const params = new URLSearchParams({
          start: "1900-01-01T00:00",
          end: "2200-01-01T00:00",
        });
        const response = await fetch(`/api/tasks?${params.toString()}`);

        if (!response.ok) {
          throw new Error("Could not load task history.");
        }

        const tasks = await response.json();
        if (!cancelled) {
          setHistoryTasks(
            tasks
              .filter((task) => ["completed", "cancelled"].includes(task.status))
              .sort((a, b) => b.start.localeCompare(a.start)),
          );
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not load task history.");
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    }

    loadHistoryTasks();
    return () => { cancelled = true; };
  }, [historyRefresh]);

  function changeSection(section) {
    setActiveSection(section);
    setSidebarOpen(false);
    setError("");
  }

  function changeView(nextView) {
    calendarApi()?.changeView(nextView);
    setView(nextView);
  }

  function navigate(direction) {
    if (direction === "today") {
      calendarApi()?.today();
    } else if (direction === "prev") {
      calendarApi()?.prev();
    } else {
      calendarApi()?.next();
    }
  }

  function toggleCategory(name) {
    setActiveCategories((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  }

  function addFiles(event) {
    const selectedFiles = Array.from(event.target.files || []);

    setFiles((current) => {
      const combined = [...current];

      for (const file of selectedFiles) {
        const duplicate = combined.some(
          (existing) =>
            existing.name === file.name &&
            existing.size === file.size &&
            existing.lastModified === file.lastModified,
        );

        if (!duplicate) {
          combined.push(file);
        }
      }

      return combined;
    });

    event.target.value = "";
  }

  function removeFile(index) {
    setFiles((current) => current.filter((_, i) => i !== index));
  }

  async function submitPrompt(event, promptOverride = null) {
    event?.preventDefault();
    const promptToSend = promptOverride ?? prompt;

    if (!promptToSend.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError("");
    setResponseMessage("");
    setOperationResults([]);

    try {
      const formData = new FormData();

      formData.append("prompt", promptToSend.trim());
      formData.append("now", formatLocalDateTime(new Date()));

      for (const file of files) {
        formData.append("files", file);
      }

      const response = await fetch("/api/prompt", {
        method: "POST",
        body: formData,
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const detail =
          typeof data.detail === "string"
            ? data.detail
            : "The request could not be processed.";

        throw new Error(detail);
      }

      setResponseMessage(data.message || "Request processed.");
      setOperationResults(data.results || []);
      setPrompt("");
      setFiles([]);

      calendarApi()?.refetchEvents();
      setHistoryRefresh((current) => current + 1);

      try {
        const categoriesResponse = await fetch("/api/categories");

        if (categoriesResponse.ok) {
          const updatedCategories = await categoriesResponse.json();

          setCategories(updatedCategories);
          setActiveCategories((current) => {
            const existingNames = new Set(
              updatedCategories.map((category) => category.name),
            );

            const retained = current.filter((name) =>
              existingNames.has(name),
            );

            const newNames = updatedCategories
              .map((category) => category.name)
              .filter((name) => !current.includes(name));

            return [...retained, ...newNames];
          });
        }
      } catch {
        // Keep the current category list if refreshing it fails.
      }
    } catch (err) {
      setError(err.message || "Something went wrong while processing your request.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between border-b bg-background px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Toggle navigation"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Menu className="size-5" />
          </Button>

          <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <CalendarDays className="size-5" />
          </div>

          <div>
            <h1 className="text-base font-semibold tracking-tight sm:text-lg">
              Task Manager
            </h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              Make time for what matters.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {activeSection === "calendar" && (
          <>
          <Button variant="outline" size="sm" onClick={() => navigate("today")}>
            Today
          </Button>

          <div className="hidden items-center sm:flex">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous period"
              onClick={() => navigate("prev")}
            >
              <ChevronLeft className="size-4" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              aria-label="Next period"
              onClick={() => navigate("next")}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
          </>
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {sidebarOpen && (
          <button
            type="button"
            aria-label="Close navigation"
            className="fixed inset-0 z-30 bg-black/30 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <aside
          className={`${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          } fixed inset-y-16 left-0 z-40 flex w-64 flex-col border-r bg-background p-5 transition-transform duration-200 md:static md:z-auto md:translate-x-0`}
        >
          <Button
            className="w-full justify-start gap-2"
            onClick={() => {
              document.querySelector("#task-prompt")?.focus();
              setSidebarOpen(false);
            }}
          >
            <Plus className="size-4" />
            Describe a task
          </Button>

          <nav className="mt-6 space-y-1" aria-label="Task views">
            <button
              type="button"
              onClick={() => changeSection("calendar")}
              aria-current="page"
              className="flex w-full items-center gap-3 rounded-lg bg-primary/10 px-3 py-2.5 text-sm font-medium text-primary"
            >
              <CalendarDays className="size-4" />
              <span>My Calendar</span>
            </button>
          </nav>

          {activeSection === "calendar" && (
          <>
          <div className="mt-8">
            <div className="mb-3">
              <h2 className="text-sm font-semibold">Calendar views</h2>
            </div>

            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {[
                { label: "Day", value: "timeGridDay" },
                { label: "Week", value: "timeGridWeek" },
                { label: "Month", value: "dayGridMonth" },
              ].map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => changeView(item.value)}
                  className={`rounded-md px-1 py-2 text-xs font-medium transition-colors ${
                    view === item.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-8">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Categories</h2>
              <ListFilter className="size-4 text-muted-foreground" />
            </div>

            {categories.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Loading categories...
              </p>
            ) : (
              <div className="space-y-1">
                {categories.map((category) => {
                  const active = activeCategories.includes(category.name);

                  return (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => toggleCategory(category.name)}
                      aria-pressed={active}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                        active
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground opacity-60 hover:bg-muted/60"
                      }`}
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: category.color }}
                      />
                      <span>{category.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          </>
          )}

          <div className="mt-auto hidden rounded-xl border p-4 md:block">
            <p className="text-sm font-medium">Plan naturally</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Describe your plans in everyday language. Your assistant will
              organize them for you.
            </p>
          </div>
        </aside>

        <main className="min-w-0 flex-1 p-3 sm:p-5 lg:p-7">
          <div className="mx-auto max-w-7xl">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-sm text-muted-foreground">
                  {activeSection === "calendar"
                    ? "Your schedule"
                    : activeSection === "completed"
                      ? "Task history"
                      : "Task history"}
                </p>
                <h2 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
                  {activeSection === "calendar"
                    ? "Plan your time"
                    : activeSection === "completed"
                      ? "Completed tasks"
                      : "Cancelled tasks"}
                </h2>
              </div>

              {activeSection === "calendar" && (
              <div className="flex items-center gap-1 rounded-lg border p-1 sm:hidden">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous period"
                  onClick={() => navigate("prev")}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next period"
                  onClick={() => navigate("next")}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
              )}
            </div>

            {error && (
              <div
                role="alert"
                className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              >
                <span>{error}</span>
                <button
                  type="button"
                  aria-label="Dismiss error"
                  onClick={() => setError("")}
                >
                  <X className="size-4" />
                </button>
              </div>
            )}

            {responseMessage && (
              <div className="mb-4 rounded-lg border bg-card px-4 py-3">
                <p className="text-sm font-medium">{responseMessage}</p>

                {operationResults.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {operationResults.map((result, index) => (
                      <div
                        key={`${result.action}-${index}`}
                        className="text-xs text-muted-foreground"
                      >
                        <span className="font-medium capitalize">
                          {result.action}
                        </span>
                        : {result.ok} successful
                        {result.failed?.length > 0 &&
                          `, ${result.failed.length} failed (${result.failed.join(", ")})`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <section className="min-w-0 overflow-hidden rounded-xl border bg-card p-2 shadow-sm sm:p-4">
                <FullCalendar
                  ref={calendarRef}
                  plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
                  initialView="timeGridWeek"
                  headerToolbar={{ left: "title", center: "", right: "" }}
                  height="auto"
                  nowIndicator
                  allDaySlot={false}
                  dayMaxEvents
                  weekends
                  expandRows
                  slotMinTime="00:00:00"
                  slotMaxTime="24:00:00"
                  slotDuration="00:30:00"
                  scrollTime="08:00:00"
                  events={loadCalendarEvents}
                  eventDisplay="block"
                  eventClick={(info) => setSelectedTask(info.event.extendedProps.task)}
                  handleWindowResize
                  eventTimeFormat={{ hour: "numeric", minute: "2-digit", meridiem: "short" }}
                  eventContent={(arg) => (
                    <div className="overflow-hidden px-0.5 py-0.5 leading-tight">
                      <div className="truncate text-xs font-semibold sm:text-sm" title={arg.event.title}>
                        {arg.event.title}
                      </div>
                      <div className="truncate text-[10px] sm:text-xs">
                        {arg.timeText}
                      </div>
                    </div>
                  )}
                  eventDidMount={(info) => {
                    const { category, status, description } = info.event.extendedProps;
                    info.el.title = [
                      info.event.title,
                      category ? `Category: ${category}` : "",
                      status ? `Status: ${status}` : "",
                      description || "",
                    ].filter(Boolean).join("\n");
                  }}
                />
              </section>

              <aside className="min-w-0 space-y-3" aria-label="Task history">
                <div className="rounded-xl border bg-card shadow-sm">
                  <details open>
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                      <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                        <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                        Completed
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{historyTasks.filter((task) => task.status === "completed").length}</span>
                      </span>
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    </summary>
                    <div className="max-h-72 space-y-1 overflow-y-auto border-t p-2">
                      {isLoadingHistory ? (
                        <p className="p-3 text-xs text-muted-foreground">Loading tasks...</p>
                      ) : historyTasks.filter((task) => task.status === "completed").length === 0 ? (
                        <p className="p-3 text-xs text-muted-foreground">Completed tasks will appear here.</p>
                      ) : historyTasks.filter((task) => task.status === "completed").map((task) => (
                        <button key={task.id} type="button" onClick={() => setSelectedTask(task)} className="flex w-full min-w-0 items-start gap-2 rounded-lg p-2 text-left hover:bg-muted">
                          <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: task.color }} />
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-sm font-medium leading-snug">{task.title}</span>
                            <span className="mt-1 block text-xs text-muted-foreground">{new Date(task.start).toLocaleDateString()} · {new Date(task.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </details>
                </div>

                <div className="rounded-xl border bg-card shadow-sm">
                  <details open>
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                      <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                        <Ban className="size-4 shrink-0 text-muted-foreground" />
                        Cancelled
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{historyTasks.filter((task) => task.status === "cancelled").length}</span>
                      </span>
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    </summary>
                    <div className="max-h-72 space-y-1 overflow-y-auto border-t p-2">
                      {isLoadingHistory ? (
                        <p className="p-3 text-xs text-muted-foreground">Loading tasks...</p>
                      ) : historyTasks.filter((task) => task.status === "cancelled").length === 0 ? (
                        <p className="p-3 text-xs text-muted-foreground">Cancelled tasks will appear here.</p>
                      ) : historyTasks.filter((task) => task.status === "cancelled").map((task) => (
                        <button key={task.id} type="button" onClick={() => setSelectedTask(task)} className="flex w-full min-w-0 items-start gap-2 rounded-lg p-2 text-left hover:bg-muted">
                          <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: task.color }} />
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-sm font-medium leading-snug">{task.title}</span>
                            <span className="mt-1 block text-xs text-muted-foreground">{new Date(task.start).toLocaleDateString()} · {new Date(task.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </details>
                </div>
                <p className="px-1 text-xs leading-relaxed text-muted-foreground">Select any event or history item to read its full details. Restore or change a task by describing the action in the prompt below.</p>
              </aside>
            </div>

            {selectedTask && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedTask(null); }}>
                <section role="dialog" aria-modal="true" aria-labelledby="task-detail-title" className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border bg-background p-5 shadow-xl sm:p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-1.5 size-3 shrink-0 rounded-full" style={{ backgroundColor: selectedTask.color }} />
                      <div className="min-w-0">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Task details</p>
                        <h3 id="task-detail-title" className="mt-1 break-words text-xl font-semibold leading-snug">{selectedTask.title}</h3>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" aria-label="Close task details" onClick={() => setSelectedTask(null)}><X className="size-4" /></Button>
                  </div>
                  <div className="mt-5 space-y-4 text-sm">
                    <div className="flex items-start gap-3"><ListFilter className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><p className="text-xs text-muted-foreground">Category</p><p className="mt-0.5 font-medium">{selectedTask.category || "General"}</p></div></div>
                    <div className="flex items-start gap-3"><Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><p className="text-xs text-muted-foreground">Schedule</p><p className="mt-0.5 font-medium">{new Date(selectedTask.start).toLocaleString()} – {new Date(selectedTask.end).toLocaleString()}</p></div></div>
                    <div><p className="text-xs text-muted-foreground">Status</p><p className="mt-1 inline-flex rounded-full bg-muted px-2.5 py-1 text-xs font-medium capitalize">{selectedTask.status}</p></div>
                    <div><p className="text-xs text-muted-foreground">Description</p><p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{selectedTask.description?.trim() || "No description provided."}</p></div>
                    <div className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">To change or restore this task, enter a prompt such as <span className="font-medium text-foreground">“Restore task #{selectedTask.id}”</span> or <span className="font-medium text-foreground">“Move task #{selectedTask.id} to tomorrow at 10 AM.”</span></div>
                  </div>
                </section>
              </div>
            )}

            <p className="mt-3 text-xs text-muted-foreground">
              {activeSection === "calendar"
                ? "Your active schedule is here. Completed and cancelled tasks are listed alongside it; select any task to read its details."
                : "This view shows historical tasks from your task database."}
            </p>
          </div>
        </main>
      </div>

      <footer className="sticky bottom-0 z-20 border-t bg-background/95 px-3 py-3 backdrop-blur sm:px-6 sm:py-4">
        <form
          onSubmit={submitPrompt}
          className="mx-auto max-w-4xl rounded-2xl border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/20"
        >
          {files.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1">
              {files.map((file, index) => (
                <div
                  key={`${file.name}-${file.lastModified}-${index}`}
                  className="flex max-w-full items-center gap-2 rounded-lg border bg-muted px-2 py-1 text-xs"
                >
                  <Paperclip className="size-3 shrink-0" />
                  <span className="max-w-48 truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => removeFile(index)}
                    className="shrink-0"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.csv,.md,.ics"
              className="hidden"
              onChange={addFiles}
            />

            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Attach files"
              title="Attach files"
              disabled={isSubmitting}
              onClick={() => fileInputRef.current?.click()}
              className="mb-0.5 shrink-0"
            >
              <Paperclip className="size-5" />
            </Button>

            <textarea
              id="task-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Add a task, move a meeting, or plan your week..."
              rows={1}
              disabled={isSubmitting}
              className="max-h-32 min-h-10 flex-1 resize-y bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
              aria-label="Describe a task or schedule change"
            />

            <Button
              type="submit"
              size="icon"
              aria-label="Send prompt"
              disabled={!prompt.trim() || isSubmitting}
              className="mb-0.5 shrink-0 rounded-xl"
            >
              {isSubmitting ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </div>
        </form>

        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Describe what you need. Your AI assistant will organize your schedule.
        </p>
      </footer>
    </div>
  );
}

export default App;