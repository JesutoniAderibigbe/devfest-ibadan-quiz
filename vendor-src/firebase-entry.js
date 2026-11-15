export { initializeApp } from "firebase/app";
export { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
export {
  initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, onSnapshot, serverTimestamp,
} from "firebase/firestore";
