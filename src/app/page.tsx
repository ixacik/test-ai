"use client";

import { useState, useMemo, ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Loader2,
  RotateCcw,
  ArrowLeft,
  UploadCloud,
  FileText,
  AlertTriangle,
  Sparkles,
  ChevronsRight,
  X,
  Plus,
} from "lucide-react";

// Define types (consistent with backend)
type Option = {
  option: string;
  correct: boolean;
};

type QuizQuestion = {
  question: string;
  options: Option[];
};

type UploadedFile = {
  file: File;
  id: string;
  name: string;
  status: "pending" | "uploading" | "uploaded" | "error";
  error?: string;
};

// Shuffle utility function
function shuffleArray<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

export default function PdfQuizPage() {
  const [selectedFiles, setSelectedFiles] = useState<UploadedFile[]>([]);
  const [vectorStoreId, setVectorStoreId] = useState<string | null>(null);

  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState<Option | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [score, setScore] = useState(0);

  const [isLoading, setIsLoading] = useState(false); // General loading for API calls
  const [isUploading, setIsUploading] = useState(false); // Specific for file uploads
  const [error, setError] = useState<string | null>(null);

  const [quizStarted, setQuizStarted] = useState(false);
  const [quizFinished, setQuizFinished] = useState(false);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    const newFiles: UploadedFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type === "application/pdf") {
        newFiles.push({
          file,
          id: Math.random().toString(36).substr(2, 9),
          name: file.name,
          status: "pending",
        });
      }
    }

    if (newFiles.length === 0) {
      setError("Please select at least one valid PDF file.");
      return;
    }

    setSelectedFiles((prev) => [...prev, ...newFiles]);
    setError(null);

    // Clear the input so the same files can be selected again if needed
    event.target.value = "";
  };

  const removeFile = (fileId: string) => {
    setSelectedFiles((prev) => prev.filter((file) => file.id !== fileId));
  };

  const resetQuizState = () => {
    setQuestions([]);
    setCurrentQuestionIndex(0);
    setSelectedOption(null);
    setIsAnswered(false);
    setScore(0);
    setQuizStarted(false);
    setQuizFinished(false);
    setError(null);
  };

  const handleProcessQuizData = (
    data: unknown,
    isAppending: boolean = false,
  ) => {
    const quizData = data as { quiz?: QuizQuestion[] };
    if (
      quizData &&
      quizData.quiz &&
      Array.isArray(quizData.quiz) &&
      quizData.quiz.length > 0
    ) {
      const newQuestions = quizData.quiz;
      if (isAppending) {
        setQuestions((prevQuestions) => {
          const updatedQuestions = [...prevQuestions, ...newQuestions];
          setCurrentQuestionIndex(prevQuestions.length); // Start at the first new appended question
          return updatedQuestions;
        });
      } else {
        setQuestions(newQuestions);
        setCurrentQuestionIndex(0);
      }
      setSelectedOption(null);
      setIsAnswered(false);
      setQuizStarted(true);
      setQuizFinished(false);
      setError(null);
    } else {
      setError(
        isAppending
          ? "The API returned no new questions from the PDFs, or the format was unexpected."
          : "No questions could be generated from these PDFs, or the data format was unexpected.",
      );
      if (!isAppending) {
        setQuizStarted(false); // Ensure quiz doesn't start if initial fetch fails to produce questions
        setQuestions([]);
      }
    }
  };

  const uploadFilesToVectorStore = async () => {
    if (selectedFiles.length === 0) {
      setError("No PDF files selected.");
      return null;
    }

    setIsUploading(true);
    setError(null);

    // Update all files to uploading status
    setSelectedFiles((prev) =>
      prev.map((file) => ({ ...file, status: "uploading" as const })),
    );

    const formData = new FormData();
    selectedFiles.forEach((fileObj) => {
      formData.append(`files`, fileObj.file);
    });

    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let errorMsg = `Upload Error: ${response.status}`;
        try {
          const errorData = await response.json();
          errorMsg = errorData.message || errorData.error || errorMsg;
        } catch (e) {
          errorMsg = response.statusText || `${e}`;
        }
        throw new Error(errorMsg);
      }

      const data = await response.json();

      // Update files to uploaded status
      setSelectedFiles((prev) =>
        prev.map((file) => ({ ...file, status: "uploaded" as const })),
      );

      return data.vectorStoreId;
    } catch (e: unknown) {
      console.error("Failed to upload files:", e);
      setError(
        (e as Error).message ||
          "An unexpected error occurred while uploading the PDF files.",
      );

      // Update files to error status
      setSelectedFiles((prev) =>
        prev.map((file) => ({
          ...file,
          status: "error" as const,
          error: (e as Error).message,
        })),
      );

      return null;
    } finally {
      setIsUploading(false);
    }
  };

  const fetchQuizFromVectorStore = async (
    vectorStoreId: string,
    isContinuation: boolean = false,
  ) => {
    setIsLoading(true);
    setError(null);

    if (!isContinuation) {
      // Reset parts of state for a fresh start
      setQuestions([]);
      setCurrentQuestionIndex(0);
      setSelectedOption(null);
      setIsAnswered(false);
      setScore(0);
      setQuizFinished(false);
    }

    const requestBody = {
      vectorStoreId,
      existingQuestions:
        isContinuation && questions.length > 0
          ? questions.map((q) => q.question)
          : [],
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        let errorMsg = `API Error: ${response.status}`;
        try {
          const errorData = await response.json();
          errorMsg = errorData.message || errorData.error || errorMsg;
        } catch (e) {
          errorMsg = response.statusText || `${e}`;
        }
        throw new Error(errorMsg);
      }

      const data = await response.json();
      handleProcessQuizData(data, isContinuation);
    } catch (e: unknown) {
      console.error("Failed to fetch quiz from vector store:", e);
      setError(
        (e as Error).message ||
          "An unexpected error occurred while generating the quiz.",
      );
      if (!isContinuation) setQuizStarted(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartQuiz = async () => {
    if (selectedFiles.length === 0) {
      setError("Please select at least one PDF file first.");
      return;
    }

    // First upload files to vector store if not already uploaded
    let currentVectorStoreId = vectorStoreId;

    if (
      !currentVectorStoreId ||
      selectedFiles.some((file) => file.status !== "uploaded")
    ) {
      currentVectorStoreId = await uploadFilesToVectorStore();
      if (!currentVectorStoreId) return; // Upload failed
      setVectorStoreId(currentVectorStoreId);
    }

    // Then generate quiz from vector store
    await fetchQuizFromVectorStore(currentVectorStoreId, false);
  };

  const handleFetchAndContinueQuiz = async () => {
    if (!vectorStoreId) return;
    await fetchQuizFromVectorStore(vectorStoreId, true);
  };

  const handleRestartQuizFromFiles = async () => {
    if (!vectorStoreId) return;
    await fetchQuizFromVectorStore(vectorStoreId, false);
  };

  const handleUploadNewFiles = () => {
    resetQuizState();
    setSelectedFiles([]);
    setVectorStoreId(null);
  };

  // Memoize shuffled options to prevent reshuffling on every render
  const shuffledOptions = useMemo(() => {
    if (questions.length === 0 || currentQuestionIndex >= questions.length) {
      return [];
    }
    return shuffleArray(questions[currentQuestionIndex].options);
  }, [questions, currentQuestionIndex]);

  const handleOptionSelect = (option: Option) => {
    if (isAnswered) return; // Prevent changing selection after answering
    setSelectedOption(option);
    setIsAnswered(true);
    if (option.correct) {
      setScore((prev) => prev + 1);
    }
  };

  const handleNextQuestion = () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((prev) => prev + 1);
      setSelectedOption(null);
      setIsAnswered(false);
    } else {
      setQuizFinished(true);
    }
  };

  const getFileStatusIcon = (status: UploadedFile["status"]) => {
    switch (status) {
      case "pending":
        return <FileText className="h-4 w-4 text-gray-400" />;
      case "uploading":
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
      case "uploaded":
        return <FileText className="h-4 w-4 text-green-500" />;
      case "error":
        return <AlertTriangle className="h-4 w-4 text-red-500" />;
      default:
        return <FileText className="h-4 w-4 text-gray-400" />;
    }
  };

  const getFileStatusText = (status: UploadedFile["status"]) => {
    switch (status) {
      case "pending":
        return "Ready to upload";
      case "uploading":
        return "Uploading...";
      case "uploaded":
        return "Uploaded successfully";
      case "error":
        return "Upload failed";
      default:
        return "Unknown status";
    }
  };

  if (quizStarted && !quizFinished && questions.length > 0) {
    const currentQuestion = questions[currentQuestionIndex];
    const progress = ((currentQuestionIndex + 1) / questions.length) * 100;

    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <div className="mx-auto max-w-4xl">
          <div className="mb-6 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={handleUploadNewFiles}
              className="flex items-center gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              Upload New Files
            </Button>
            <div className="text-sm text-gray-600">
              Question {currentQuestionIndex + 1} of {questions.length} • Score:{" "}
              {score}
            </div>
          </div>

          <div className="mb-4 h-2 w-full rounded-full bg-gray-200">
            <div
              className="h-2 rounded-full bg-blue-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-xl">
                {currentQuestion.question}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {shuffledOptions.map((option, index) => {
                  const isSelected = selectedOption === option;
                  const isCorrect = option.correct;
                  const showResult = isAnswered;

                  let buttonClass =
                    "w-full p-4 text-left border-2 rounded-lg transition-all ";
                  buttonClass += showResult
                    ? "cursor-default "
                    : "cursor-pointer ";
                  if (showResult) {
                    if (isCorrect) {
                      buttonClass +=
                        "border-green-500 bg-green-50 text-green-800";
                    } else if (isSelected && !isCorrect) {
                      buttonClass += "border-red-500 bg-red-50 text-red-800";
                    } else {
                      buttonClass += "border-gray-200 bg-gray-50 text-gray-600";
                    }
                  } else if (isSelected) {
                    buttonClass += "border-blue-500 bg-blue-50 text-blue-800";
                  } else {
                    buttonClass +=
                      "border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:shadow-sm";
                  }

                  return (
                    <button
                      key={index}
                      onClick={() => handleOptionSelect(option)}
                      disabled={isAnswered}
                      className={buttonClass}
                    >
                      <div className="flex items-center justify-between">
                        <span>{option.option}</span>
                        {showResult && isCorrect && (
                          <span className="text-green-600 font-medium">
                            ✓ Correct
                          </span>
                        )}
                        {showResult && isSelected && !isCorrect && (
                          <span className="text-red-600 font-medium">
                            ✗ Incorrect
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {isAnswered && (
                <div className="mt-6 flex justify-between">
                  <Button
                    onClick={handleNextQuestion}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    {currentQuestionIndex < questions.length - 1
                      ? "Next Question"
                      : "Finish Quiz"}
                    <ChevronsRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (quizFinished) {
    const percentage = Math.round((score / questions.length) * 100);
    let performanceMessage = "";
    let performanceColor = "";

    if (percentage >= 90) {
      performanceMessage = "Excellent work! 🎉";
      performanceColor = "text-green-600";
    } else if (percentage >= 70) {
      performanceMessage = "Good job! 👍";
      performanceColor = "text-blue-600";
    } else if (percentage >= 50) {
      performanceMessage = "Not bad, but there's room for improvement. 📚";
      performanceColor = "text-yellow-600";
    } else {
      performanceMessage = "Keep studying and try again! 💪";
      performanceColor = "text-red-600";
    }

    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <div className="mx-auto max-w-2xl">
          <Card className="text-center">
            <CardHeader>
              <CardTitle className="text-3xl mb-2">Quiz Complete!</CardTitle>
              <CardDescription className="text-lg">
                Here are your results
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-6">
                <div className="text-6xl font-bold text-blue-600 mb-2">
                  {score}/{questions.length}
                </div>
                <div className="text-2xl text-gray-600 mb-4">
                  {percentage}% correct
                </div>
                <div className={`text-xl font-medium ${performanceColor}`}>
                  {performanceMessage}
                </div>
              </div>

              {error && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-center gap-2 text-red-800">
                    <AlertTriangle className="h-5 w-5" />
                    <span>{error}</span>
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button
                  onClick={handleFetchAndContinueQuiz}
                  disabled={isLoading}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Plus className="mr-2 h-4 w-4" />
                      More Questions
                    </>
                  )}
                </Button>

                <Button
                  onClick={handleRestartQuizFromFiles}
                  disabled={isLoading}
                  variant="outline"
                  className="border-blue-600 text-blue-600 hover:bg-blue-50"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <RotateCcw className="mr-2 h-4 w-4" />
                      Restart Quiz
                    </>
                  )}
                </Button>

                <Button
                  onClick={handleUploadNewFiles}
                  variant="outline"
                  className="border-gray-600 text-gray-600 hover:bg-gray-50"
                >
                  <UploadCloud className="mr-2 h-4 w-4" />
                  Upload New Files
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-3xl mb-2 flex items-center justify-center gap-2">
              <Sparkles className="h-8 w-8 text-blue-600" />
              AI Quiz Generator
            </CardTitle>
            <CardDescription>
              Upload multiple PDF files and generate intelligent quizzes using
              AI
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select PDF Files
                </label>
                <div className="flex items-center justify-center w-full">
                  <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-gray-300 border-dashed rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100">
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      <UploadCloud className="w-8 h-8 mb-2 text-gray-500" />
                      <p className="mb-2 text-sm text-gray-500">
                        <span className="font-semibold">Click to upload</span>{" "}
                        PDF files
                      </p>
                      <p className="text-xs text-gray-500">
                        Multiple PDFs supported
                      </p>
                    </div>
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf"
                      multiple
                      onChange={handleFileChange}
                    />
                  </label>
                </div>
              </div>

              {selectedFiles.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-3">
                    Selected Files ({selectedFiles.length})
                  </h3>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {selectedFiles.map((fileObj) => (
                      <div
                        key={fileObj.id}
                        className="flex items-center justify-between p-3 bg-white border border-gray-200 rounded-lg"
                      >
                        <div className="flex items-center gap-3">
                          {getFileStatusIcon(fileObj.status)}
                          <div>
                            <p className="text-sm font-medium text-gray-900 truncate max-w-xs">
                              {fileObj.name}
                            </p>
                            <p className="text-xs text-gray-500">
                              {getFileStatusText(fileObj.status)}
                            </p>
                            {fileObj.error && (
                              <p className="text-xs text-red-500 mt-1">
                                {fileObj.error}
                              </p>
                            )}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeFile(fileObj.id)}
                          className="text-gray-400 hover:text-red-500 h-8 w-8 p-0"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {error && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-center gap-2 text-red-800">
                    <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm">{error}</span>
                  </div>
                </div>
              )}

              <Button
                onClick={handleStartQuiz}
                disabled={
                  selectedFiles.length === 0 || isLoading || isUploading
                }
                className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                size="lg"
              >
                {isUploading ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Uploading Files...
                  </>
                ) : isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Generating Quiz...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-5 w-5" />
                    Generate Quiz from PDFs
                  </>
                )}
              </Button>

              <div className="text-center text-sm text-gray-500">
                Upload multiple PDF files to create a comprehensive quiz
                covering all your study materials
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
